"use client";

import type { User } from "firebase/auth";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MdFilterAlt,
  MdFilterAltOff,
  MdPlaylistPlay,
  MdRefresh,
  MdSmartDisplay,
  MdTune,
  MdVisibility,
  MdVisibilityOff,
} from "react-icons/md";
import { loadCachedFeed, saveCachedFeed } from "../src/feed-cache";
import { feedItemId } from "../src/feed-item";
import { compileFilter, videoPassesFilter } from "../src/filters";
import {
  loadChannelFilters,
  loadWatchedFor,
  markWatched,
  saveChannelFilter,
  signOutUser,
  syncSubscriptions,
  unmarkWatched,
  watchChannelFilters,
} from "../src/firebase";
import { buildPlayQueue, type PlayQueue } from "../src/queue";
import { useRoute } from "../src/router";
import { classifyShorts, SHORTS_MAX_SECONDS } from "../src/shorts";
import type {
  ChannelFilter,
  ContentMode,
  FeedItem,
  Playlist,
  Video,
} from "../src/types";
import {
  fetchPlaylists,
  fetchPlaylistVideoIds,
  fetchSubscriptions,
  fetchUploads,
  InsufficientScopeError,
  TokenExpiredError,
} from "../src/youtube";
import { getValidToken, silentRefresh } from "../src/youtube-token";
import AccountMenu from "./account-menu";
import ChannelFilters from "./channel-filters";
import Player from "./player";
import PlaylistCard from "./playlist-card";
import ThemeToggle from "./theme-toggle";
import VideoCard from "./video-card";

// 50 is the Data API's max per single playlistItems page (still 1 quota unit),
// so this is free relative to 15 and gives the regex tester more to preview.
const UPLOADS_PER_CHANNEL = 50;
const FETCH_CONCURRENCY = 6;

async function mapWithConcurrency<Item, Result>(
  items: Item[],
  limit: number,
  worker: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/**
 * Attach Shorts verdicts and watched-state to freshly fetched items. Shared by
 * the full feed load and the on-demand single-channel load. A video's Short-ness
 * never changes, so verdicts are reused from the last cached feed and only new
 * candidates (sub-3-min videos) are classified.
 */
async function enrichItems(
  uid: string,
  items: FeedItem[],
): Promise<{ items: FeedItem[]; watched: Set<string> }> {
  const ids = items.map(feedItemId);
  const known = new Map<string, boolean>();
  const cached = await loadCachedFeed(uid);
  for (const item of cached?.items ?? []) {
    if (item.kind === "video" && typeof item.isShort === "boolean") {
      known.set(item.videoId, item.isShort);
    }
  }
  const isCandidate = (item: FeedItem): item is Video =>
    item.kind === "video" &&
    !!item.durationSeconds &&
    item.durationSeconds <= SHORTS_MAX_SECONDS;
  const toClassify = items
    .filter((item) => isCandidate(item) && !known.has(item.videoId))
    .map(feedItemId);
  const [watched, classified] = await Promise.all([
    loadWatchedFor(uid, ids),
    classifyShorts(toClassify).catch(() => new Map<string, boolean>()),
  ]);
  const withShorts: FeedItem[] = items.map((item) => {
    if (item.kind !== "video") {
      return item;
    }
    const isShort = isCandidate(item)
      ? (known.get(item.videoId) ?? classified.get(item.videoId))
      : false;
    return { ...item, isShort };
  });
  return { items: withShorts, watched };
}

interface FeedData {
  /** The channels currently subscribed to; their filters come from the listener. */
  subscriptions: string[];
  watched: Set<string>;
  items: FeedItem[];
  /**
   * Whether a channel's fetch failed non-fatally (e.g. a quota 403), making the
   * result partial — it must not overwrite the cache.
   */
  partial: boolean;
}

export default function Feed({
  user,
  ready,
  checking,
  connecting,
  onReconnect,
  onDisconnect,
  onTokenLost,
}: {
  user: User;
  ready: boolean;
  checking: boolean;
  connecting: boolean;
  onReconnect: () => void;
  onDisconnect: () => Promise<void>;
  onTokenLost: () => void;
}): ReactElement {
  // every stored filter, including channels no longer subscribed to (their
  // documents outlive the subscription), narrowed to `subscriptions` below
  const [channelFilters, setChannelFilters] = useState<
    Map<string, ChannelFilter>
  >(new Map());
  const [subscriptions, setSubscriptions] = useState<string[]>([]);
  // edits whose debounced write hasn't been issued yet; once it is, Firestore
  // replays it to the listener and the entry is dropped
  const [filterEdits, setFilterEdits] = useState<Map<string, ChannelFilter>>(
    new Map(),
  );
  const [watched, setWatched] = useState<Set<string>>(new Set());
  // Snapshot of watched-at-load used to decide what to HIDE, so items watched
  // during this session stay (dimmed) and only drop out on the next load.
  const [hiddenWatched, setHiddenWatched] = useState<Set<string>>(new Set());
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWatched, setShowWatched] = useState(false);
  const [bypassFilters, setBypassFilters] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  // The "Play all" queue, snapshotted (with playlists expanded) when the button
  // is pressed, so it doesn't reshape as it marks its way through. `preparing`
  // covers the playlist fetch between press and open.
  const [playQueue, setPlayQueue] = useState<PlayQueue | null>(null);
  const [preparingQueue, setPreparingQueue] = useState(false);
  // non-fatal buttonless banner, separate from `error` (which pairs with a Connect button)
  const [notice, setNotice] = useState<string | null>(null);
  const { route, open, close } = useRoute();
  const channelView = route.channel;
  const openItem = route.item;
  // A channel page for a channel that isn't in the loaded feed (e.g. disabled)
  // fetches that channel's items on demand, like the regex tester does.
  const [channelItems, setChannelItems] = useState<{
    id: string;
    mode: ContentMode;
    items: FeedItem[];
  } | null>(null);
  const [channelLoading, setChannelLoading] = useState(false);
  const [channelError, setChannelError] = useState<string | null>(null);

  // the listener's filters, for a load to diff against without re-reading them
  const syncedFilters = useRef<Map<string, ChannelFilter> | null>(null);

  useEffect(
    () =>
      watchChannelFilters(user.uid, (filters, synced) => {
        setChannelFilters(filters);
        if (synced) {
          syncedFilters.current = filters;
        }
      }),
    [user.uid],
  );

  // the subscribed channels, each with its stored filter or the edit still on its
  // way to Firestore
  const channels = useMemo(() => {
    const merged = new Map<string, ChannelFilter>();
    for (const channelId of subscriptions) {
      const filter =
        filterEdits.get(channelId) ?? channelFilters.get(channelId);
      if (filter) {
        merged.set(channelId, filter);
      }
    }
    return merged;
  }, [subscriptions, channelFilters, filterEdits]);

  const fetchEverything = useCallback(
    async (token: string): Promise<FeedData> => {
      const subscribed = await fetchSubscriptions(token);
      // The listener's filters, once the server has confirmed them, are the same
      // documents a read would return. Before that they may be a stale cache, and
      // syncSubscriptions would mistake a missing filter for a new channel and
      // overwrite it with defaults — so that case still pays for the read.
      const existing =
        syncedFilters.current ?? (await loadChannelFilters(user.uid));
      const merged = await syncSubscriptions(user.uid, subscribed, existing);

      const enabled = Array.from(merged.values()).filter(
        (channel) => channel.enabled,
      );
      let failed = 0;
      const loaded = await mapWithConcurrency(
        enabled,
        FETCH_CONCURRENCY,
        async (channel) => {
          try {
            return channel.contentMode === "playlists"
              ? await fetchPlaylists(channel.channelId, channel.title, token)
              : await fetchUploads(
                  channel.channelId,
                  channel.title,
                  token,
                  UPLOADS_PER_CHANNEL,
                );
          } catch (caught) {
            if (
              caught instanceof TokenExpiredError ||
              caught instanceof InsufficientScopeError
            ) {
              throw caught;
            }
            failed++;
            return [] as FeedItem[];
          }
        },
      );
      const enriched = await enrichItems(user.uid, loaded.flat());
      return {
        subscriptions: Array.from(merged.keys()),
        watched: enriched.watched,
        items: enriched.items,
        partial: failed > 0,
      };
    },
    [user.uid],
  );

  const loadFeed = useCallback(async () => {
    setLoading(true);
    setError(null);
    let token: string;
    try {
      token = await getValidToken();
    } catch {
      onTokenLost();
      setError("Reconnect YouTube to load your feed.");
      setLoading(false);
      return;
    }
    try {
      let data: FeedData;
      try {
        data = await fetchEverything(token);
      } catch (caught) {
        if (!(caught instanceof TokenExpiredError)) {
          throw caught;
        }
        // The token died mid-load; mint a fresh one silently and retry once.
        data = await fetchEverything(await silentRefresh());
      }
      setSubscriptions(data.subscriptions);
      setWatched(data.watched);
      setHiddenWatched(data.watched);
      setItems(data.items);
      // a partial load must not overwrite the good cache; surface a notice instead
      if (data.partial) {
        setNotice("Some channels couldn't be loaded; showing partial results.");
      } else {
        setNotice(null);
        void saveCachedFeed(user.uid, {
          subscriptions: data.subscriptions,
          watched: data.watched,
          items: data.items,
          cachedAt: Date.now(),
        });
      }
    } catch (caught) {
      if (caught instanceof TokenExpiredError) {
        onTokenLost();
        setError("Your YouTube session ended. Reconnect to refresh.");
      } else if (caught instanceof InsufficientScopeError) {
        onTokenLost();
        setError(
          "subtube needs permission to read your YouTube account. Click Reconnect and allow YouTube access.",
        );
      } else {
        setError((caught as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, [fetchEverything, onTokenLost, user.uid]);

  useEffect(() => {
    if (ready) {
      void loadFeed();
    }
  }, [ready, loadFeed]);

  // Enabled channels are already in the loaded feed; only a disabled (or unknown)
  // channel's page needs an on-demand fetch. Keying on the content mode too means
  // flipping videos<->playlists on the page refetches.
  const channelEntry = channelView ? channels.get(channelView) : undefined;
  const channelMode: ContentMode = channelEntry?.contentMode ?? "videos";
  const channelTitle = channelEntry?.title ?? channelView ?? "";
  const onDemandChannel =
    channelView !== null && channelEntry?.enabled !== true;
  useEffect(() => {
    if (!channelView || !onDemandChannel) {
      return;
    }
    if (channelItems?.id === channelView && channelItems.mode === channelMode) {
      return;
    }
    let cancelled = false;
    setChannelLoading(true);
    setChannelError(null);
    void (async () => {
      try {
        const token = await getValidToken();
        const fetched =
          channelMode === "playlists"
            ? await fetchPlaylists(channelView, channelTitle, token)
            : await fetchUploads(
                channelView,
                channelTitle,
                token,
                UPLOADS_PER_CHANNEL,
              );
        const enriched = await enrichItems(user.uid, fetched);
        if (cancelled) {
          return;
        }
        setChannelItems({
          id: channelView,
          mode: channelMode,
          items: enriched.items,
        });
        const merge = (prev: Set<string>) => {
          const next = new Set(prev);
          enriched.watched.forEach((id) => {
            next.add(id);
          });
          return next;
        };
        setWatched(merge);
        setHiddenWatched(merge);
      } catch (caught) {
        if (!cancelled) {
          setChannelError((caught as Error).message);
        }
      } finally {
        if (!cancelled) {
          setChannelLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    channelView,
    onDemandChannel,
    channelMode,
    channelTitle,
    channelItems,
    user.uid,
  ]);

  const persistTimers = useRef<Map<string, number>>(new Map());
  const updateFilter = useCallback(
    (filter: ChannelFilter) => {
      setFilterEdits((prev) => new Map(prev).set(filter.channelId, filter));
      const timers = persistTimers.current;
      const pending = timers.get(filter.channelId);
      if (pending) {
        window.clearTimeout(pending);
      }
      timers.set(
        filter.channelId,
        window.setTimeout(() => {
          void saveChannelFilter(user.uid, filter).finally(() => {
            // the listener carries this value now, unless a newer edit is waiting
            setFilterEdits((prev) => {
              if (prev.get(filter.channelId) !== filter) {
                return prev;
              }
              const next = new Map(prev);
              next.delete(filter.channelId);
              return next;
            });
          });
          timers.delete(filter.channelId);
        }, 600),
      );
    },
    [user.uid],
  );

  const toggleWatched = useCallback(
    (item: FeedItem) => {
      const id = feedItemId(item);
      const isWatched = watched.has(id);
      setWatched((prev) => {
        const next = new Set(prev);
        if (isWatched) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      if (isWatched) {
        void unmarkWatched(user.uid, id);
      } else {
        void markWatched(user.uid, id);
      }
    },
    [user.uid, watched],
  );

  // The player calls this when you leave a video (queue advance or close), so it
  // marks each in turn. Idempotent: a video already watched is left untouched.
  const markItemWatched = useCallback(
    (id: string) => {
      setWatched((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      void markWatched(user.uid, id);
    },
    [user.uid],
  );

  const feed = useMemo(() => {
    const compiled = new Map(
      Array.from(channels.values()).map((channel) => [
        channel.channelId,
        compileFilter(channel),
      ]),
    );
    // On a channel page, an enabled channel comes from the loaded feed; a
    // disabled one comes from the on-demand fetch (matched by id + content mode).
    const source = onDemandChannel
      ? channelItems?.id === channelView && channelItems.mode === channelMode
        ? channelItems.items
        : []
      : items;
    return source
      .filter((item) => {
        if (channelView && item.channelId !== channelView) {
          return false;
        }
        const filter = compiled.get(item.channelId);
        // The main feed shows only enabled channels; a channel page shows the one
        // you navigated to regardless of its enabled state.
        if (!channelView && !filter?.enabled) {
          return false;
        }
        if (filter && !bypassFilters && !videoPassesFilter(item, filter)) {
          return false;
        }
        if (!showWatched && hiddenWatched.has(feedItemId(item))) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
  }, [
    items,
    channelItems,
    onDemandChannel,
    channelMode,
    channels,
    hiddenWatched,
    showWatched,
    bypassFilters,
    channelView,
  ]);

  const hasUnwatched = useMemo(
    () => feed.some((item) => !watched.has(feedItemId(item))),
    [feed, watched],
  );

  // "Play all": expand every unwatched playlist in the current view into its
  // videos (the API call the feed itself doesn't make), build the queue, and
  // open it. Snapshotted here so it's stable while it plays.
  const playAll = useCallback(async () => {
    setPreparingQueue(true);
    try {
      const playlists = feed.filter(
        (item): item is Playlist =>
          item.kind === "playlist" && !watched.has(item.playlistId),
      );
      const fetchAll = (token: string) =>
        mapWithConcurrency(
          playlists,
          FETCH_CONCURRENCY,
          async (playlist) =>
            [
              playlist.playlistId,
              await fetchPlaylistVideoIds(playlist.playlistId, token),
            ] as const,
        );
      let entries: (readonly [string, string[]])[];
      try {
        entries = await fetchAll(await getValidToken());
      } catch (caught) {
        if (!(caught instanceof TokenExpiredError)) {
          throw caught;
        }
        entries = await fetchAll(await silentRefresh());
      }
      const queue = buildPlayQueue(feed, watched, new Map(entries));
      if (queue.videoIds.length === 0) {
        return;
      }
      setPlayQueue(queue);
      open({ channel: channelView, item: { kind: "queue" } });
    } catch (caught) {
      // mirror loadFeed's error handling; the queue just stays unopened, feed stays usable
      if (caught instanceof InsufficientScopeError) {
        onTokenLost();
        setError(
          "subtube needs permission to read your YouTube account. Click Reconnect and allow YouTube access.",
        );
      } else if (caught instanceof TokenExpiredError) {
        onTokenLost();
        setError("Your YouTube session ended. Reconnect to refresh.");
      } else {
        setError((caught as Error).message);
      }
    } finally {
      setPreparingQueue(false);
    }
  }, [feed, watched, channelView, open, onTokenLost]);

  const amberTone =
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
  // Restoring access (checking) is the expected path, so it gets a quiet spinner
  // rather than a banner. The banner is only for actionable states: an error, or
  // a not-yet-connected prompt — both paired with the Connect button.
  const statusBanner = error
    ? {
        tone: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
        message: error,
      }
    : !ready && !checking && !connecting
      ? { tone: amberTone, message: "Connect YouTube to load your feed." }
      : null;

  const latestByChannel = useMemo(() => {
    const latest = new Map<string, string>();
    for (const item of items) {
      const prior = latest.get(item.channelId);
      if (!prior || item.publishedAt > prior) {
        latest.set(item.channelId, item.publishedAt);
      }
    }
    return latest;
  }, [items]);

  return (
    <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-slate-200 border-b bg-white/90 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <button
          type="button"
          onClick={() => {
            // Avoid stacking duplicate feed entries when already home.
            if (route.channel || route.item) {
              open({ channel: null, item: null });
            }
          }}
          title="Home"
          aria-label="Home"
          className="flex shrink-0 items-center gap-1.5 font-bold text-lg"
        >
          <MdSmartDisplay className="text-red-600" />
          subtube
        </button>
        {channelView ? (
          <span className="min-w-0 flex-1 truncate text-slate-500 text-sm dark:text-slate-400">
            {channels.get(channelView)?.title ?? "Channel"}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1 text-base">
          <button
            type="button"
            className="flex items-center rounded p-1.5 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800"
            onClick={() => void loadFeed()}
            disabled={loading || !ready}
            title="Refresh"
            aria-label="Refresh"
          >
            <MdRefresh className={loading ? "animate-spin" : ""} />
          </button>
          {checking || connecting ? (
            <span
              role="status"
              aria-label="Restoring access"
              className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-500 dark:border-slate-700 dark:border-t-slate-300"
            />
          ) : null}
          <button
            type="button"
            className="flex items-center rounded p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            onClick={() => setShowWatched((shown) => !shown)}
            title={showWatched ? "Hide watched" : "Show watched"}
            aria-label={showWatched ? "Hide watched" : "Show watched"}
          >
            {showWatched ? <MdVisibility /> : <MdVisibilityOff />}
          </button>
          <button
            type="button"
            className="flex items-center rounded p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            onClick={() => setBypassFilters((shown) => !shown)}
            title={
              bypassFilters
                ? "Filters off — showing everything"
                : "Show everything (ignore filters)"
            }
            aria-label="Toggle filters"
            aria-pressed={bypassFilters}
          >
            {bypassFilters ? <MdFilterAltOff /> : <MdFilterAlt />}
          </button>
          <button
            type="button"
            className="flex items-center rounded p-1.5 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800"
            onClick={() => void playAll()}
            disabled={!hasUnwatched || preparingQueue}
            title={
              preparingQueue
                ? "Preparing…"
                : hasUnwatched
                  ? "Play all unwatched"
                  : "No unwatched videos to play"
            }
            aria-label="Play all unwatched"
          >
            <MdPlaylistPlay className={preparingQueue ? "animate-pulse" : ""} />
          </button>
          <ThemeToggle />
          <button
            type="button"
            className="flex items-center rounded p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            onClick={() => setShowFilters(true)}
            title="Channels"
            aria-label="Channels"
          >
            <MdTune />
          </button>
        </div>
        <AccountMenu
          user={user}
          ready={ready}
          onDisconnect={() => {
            setError(null);
            void onDisconnect().catch((caught) =>
              setError(
                `Couldn't disconnect YouTube: ${(caught as Error).message}`,
              ),
            );
          }}
          onSignOut={() => void signOutUser()}
        />
      </header>

      {statusBanner ? (
        <div
          className={`flex min-h-11 items-center gap-3 px-4 py-2 text-sm ${statusBanner.tone}`}
        >
          <span>{statusBanner.message}</span>
          <button
            type="button"
            className="ml-auto shrink-0 rounded bg-amber-600 px-2 py-1 text-white hover:bg-amber-500 disabled:opacity-60"
            onClick={onReconnect}
            disabled={connecting}
          >
            {connecting ? "Connecting…" : "Connect"}
          </button>
        </div>
      ) : null}

      {notice ? (
        <div
          className={`flex min-h-11 items-center gap-3 px-4 py-2 text-sm ${amberTone}`}
        >
          <span>{notice}</span>
          <button
            type="button"
            className="ml-auto shrink-0 rounded px-2 py-1 hover:bg-amber-200 dark:hover:bg-amber-800/40"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <main className="mx-auto grid max-w-7xl grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-4 p-4">
        {feed.map((item) =>
          item.kind === "playlist" ? (
            <PlaylistCard
              key={item.playlistId}
              playlist={item}
              disabled={loading}
              watched={watched.has(item.playlistId)}
              onOpen={() =>
                open({
                  channel: channelView,
                  item: { kind: "playlist", id: item.playlistId },
                })
              }
              onOpenChannel={() => {
                if (channelView !== item.channelId) {
                  open({ channel: item.channelId, item: null });
                }
              }}
              onToggleWatched={() => toggleWatched(item)}
            />
          ) : (
            <VideoCard
              key={item.videoId}
              video={item}
              disabled={loading}
              watched={watched.has(item.videoId)}
              onOpen={() =>
                open({
                  channel: channelView,
                  item: { kind: "video", id: item.videoId },
                })
              }
              onOpenChannel={() => {
                if (channelView !== item.channelId) {
                  open({ channel: item.channelId, item: null });
                }
              }}
              onToggleWatched={() => toggleWatched(item)}
            />
          ),
        )}
      </main>

      {(loading || checking) && feed.length === 0 ? (
        <p className="p-8 text-center text-slate-500 dark:text-slate-400">
          Loading your subscriptions…
        </p>
      ) : null}
      {channelLoading && feed.length === 0 ? (
        <div className="grid place-items-center p-12">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-500 dark:border-slate-700 dark:border-t-slate-300" />
        </div>
      ) : null}
      {channelError && feed.length === 0 ? (
        <p className="p-8 text-center text-red-600 text-sm dark:text-red-400">
          {channelError}
        </p>
      ) : null}
      {!loading && !channelLoading && ready && feed.length === 0 ? (
        <p className="p-8 text-center text-slate-500 dark:text-slate-400">
          No videos match your filters.
        </p>
      ) : null}

      <ChannelFilters
        open={showFilters}
        disabled={loading}
        channels={Array.from(channels.values())}
        latest={latestByChannel}
        items={items}
        onChange={updateFilter}
        onOpenChannel={(id) => {
          open({ channel: id, item: null });
          setShowFilters(false);
        }}
        onClose={() => setShowFilters(false)}
      />

      {openItem?.kind === "playlist" ? (
        <Player
          key={`list:${openItem.id}`}
          kind="playlist"
          playlistId={openItem.id}
          onClose={close}
          onWatched={markItemWatched}
        />
      ) : openItem?.kind === "video" ? (
        <Player
          key={`v:${openItem.id}`}
          kind="video"
          videoIds={[openItem.id]}
          onClose={close}
          onWatched={markItemWatched}
        />
      ) : openItem?.kind === "queue" && playQueue ? (
        <Player
          key="queue"
          kind="video"
          videoIds={playQueue.videoIds}
          marks={playQueue.marks}
          onClose={close}
          onWatched={markItemWatched}
        />
      ) : null}
    </div>
  );
}
