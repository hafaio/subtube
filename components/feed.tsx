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
} from "../src/firebase";
import { useRoute } from "../src/router";
import { classifyShorts, SHORTS_MAX_SECONDS } from "../src/shorts";
import type { ChannelFilter, ContentMode, FeedItem, Video } from "../src/types";
import {
  fetchPlaylists,
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

// Attach Shorts verdicts and watched-state to freshly fetched items. Shared by
// the full feed load and the on-demand single-channel load. A video's Short-ness
// never changes, so verdicts are reused from the last cached feed and only new
// candidates (sub-3-min videos) are classified.
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
  channels: Map<string, ChannelFilter>;
  watched: Set<string>;
  items: FeedItem[];
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
  onDisconnect: () => void;
  onTokenLost: () => void;
}): ReactElement {
  const [channels, setChannels] = useState<Map<string, ChannelFilter>>(
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

  const fetchEverything = useCallback(
    async (token: string): Promise<FeedData> => {
      const subscriptions = await fetchSubscriptions(token);
      const existing = await loadChannelFilters(user.uid);
      const merged = await syncSubscriptions(user.uid, subscriptions, existing);

      const enabled = Array.from(merged.values()).filter(
        (channel) => channel.enabled,
      );
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
            return [] as FeedItem[];
          }
        },
      );
      const enriched = await enrichItems(user.uid, loaded.flat());
      return {
        channels: merged,
        watched: enriched.watched,
        items: enriched.items,
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
      setChannels(data.channels);
      setWatched(data.watched);
      setHiddenWatched(data.watched);
      setItems(data.items);
      void saveCachedFeed(user.uid, {
        channels: data.channels,
        watched: data.watched,
        items: data.items,
        cachedAt: Date.now(),
      });
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

  // Paint the last cached feed immediately on mount, before (and during) the
  // fresh load — but never clobber data that the fresh load already set.
  useEffect(() => {
    let cancelled = false;
    void loadCachedFeed(user.uid).then((cached) => {
      if (cancelled || !cached) {
        return;
      }
      setChannels((prev) => (prev.size ? prev : cached.channels));
      setWatched((prev) => (prev.size ? prev : cached.watched));
      setHiddenWatched((prev) => (prev.size ? prev : cached.watched));
      // `?? []` tolerates a pre-playlists cache that lacks the items field.
      setItems((prev) => (prev.length ? prev : (cached.items ?? [])));
    });
    return () => {
      cancelled = true;
    };
  }, [user.uid]);

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
      setChannels((prev) => new Map(prev).set(filter.channelId, filter));
      const timers = persistTimers.current;
      const pending = timers.get(filter.channelId);
      if (pending) {
        window.clearTimeout(pending);
      }
      timers.set(
        filter.channelId,
        window.setTimeout(() => {
          void saveChannelFilter(user.uid, filter);
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

  const handlePlay = useCallback(
    (id: string) => {
      if (watched.has(id)) {
        return;
      }
      setWatched((prev) => new Set(prev).add(id));
      void markWatched(user.uid, id);
    },
    [user.uid, watched],
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
          onDisconnect={onDisconnect}
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

      <main className="mx-auto grid max-w-7xl grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-4 p-4">
        {feed.map((item) =>
          item.kind === "playlist" ? (
            <PlaylistCard
              key={item.playlistId}
              playlist={item}
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

      {loading && feed.length === 0 ? (
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

      {openItem ? (
        <Player
          kind={openItem.kind}
          id={openItem.id}
          onClose={close}
          onPlay={() => handlePlay(openItem.id)}
        />
      ) : null}
    </div>
  );
}
