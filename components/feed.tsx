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
import {
  cacheShortsVerdicts,
  loadCachedFeed,
  saveCachedFeed,
} from "../src/feed-cache";
import { feedItemId, withVerdicts } from "../src/feed-item";
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
import {
  isShortsCandidate,
  requestShortsClassification,
  watchShortsVerdicts,
} from "../src/shorts";
import type {
  ChannelFilter,
  ContentMode,
  FeedItem,
  Playlist,
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
/**
 * A load costs quota (subscriptions + an uploads page per enabled channel), so
 * returning to the app only refreshes a feed at least this stale.
 */
const REFRESH_STALE_MS = 10 * 60 * 1000;

/**
 * A watched write Firestore may not have made durable yet. The watched set is read
 * at the start of a load and applied at its end, seconds later, so a write that
 * wasn't already durable when the load began has to be re-applied over the result
 * — otherwise that older snapshot reverts it.
 */
interface PendingWrite<Value> {
  value: Value;
  /** When Firestore acknowledged the write; null while it is still in flight. */
  ackedAt: number | null;
}

/** Register a change as pending, before its (possibly debounced) write starts. */
function trackPending<Key, Value>(
  pending: Map<Key, PendingWrite<Value>>,
  key: Key,
  value: Value,
): PendingWrite<Value> {
  const entry: PendingWrite<Value> = { value, ackedAt: null };
  pending.set(key, entry);
  return entry;
}

/** Stamp a pending change once its write lands, whether or not it succeeded. */
function settlePending<Value>(
  entry: PendingWrite<Value>,
  write: Promise<void>,
): void {
  void write.finally(() => {
    // stamps this entry, not the map slot, which a newer change may have taken
    entry.ackedAt = Date.now();
  });
}

/**
 * Forget the writes already durable when a load starting at `startedAt` read
 * Firestore, since its result contains them. What's left raced that read.
 */
function prunePending<Key, Value>(
  pending: Map<Key, PendingWrite<Value>>,
  startedAt: number,
): void {
  for (const [key, entry] of pending) {
    if (entry.ackedAt !== null && entry.ackedAt < startedAt) {
      pending.delete(key);
    }
  }
}

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
 * Attach watched-state and any known Shorts verdict to freshly fetched items.
 * Shared by the full feed load and the on-demand single-channel load. A candidate
 * with no verdict is left undefined rather than guessed at; the listener below
 * fills it in when one arrives.
 */
async function enrichItems(
  uid: string,
  items: FeedItem[],
  known: Map<string, boolean>,
): Promise<{ items: FeedItem[]; watched: Set<string> }> {
  const watched = await loadWatchedFor(uid, items.map(feedItemId));
  const withShorts: FeedItem[] = items.map((item) => {
    if (item.kind !== "video") {
      return item;
    }
    // a video too long to be a Short needs no verdict at all
    const isShort = isShortsCandidate(item) ? known.get(item.videoId) : false;
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
  // whether the filter listener has delivered a snapshot, cached or not; until it
  // has there is nothing to filter with, and the cached feed would paint unfiltered
  const [filtersLoaded, setFiltersLoaded] = useState(false);
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
  // true until the cached feed has been read back, so the empty states don't
  // flash before the instant paint
  const [hydrating, setHydrating] = useState(true);
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

  const loadInFlight = useRef(false);
  // stamped on every load attempt, failures included, and compared against
  // REFRESH_STALE_MS
  const lastAttemptAt = useRef(0);
  // whether a load has landed, so a slow cache read can't overwrite one that beat it
  const feedApplied = useRef(false);
  // Short-ness never changes, so verdicts carry across loads
  const shortsVerdicts = useRef<Map<string, boolean>>(new Map());
  const pendingWatched = useRef<Map<string, PendingWrite<boolean>>>(new Map());
  // the listener's filters, for a load to diff against without re-reading them
  const syncedFilters = useRef<Map<string, ChannelFilter> | null>(null);

  useEffect(
    () =>
      watchChannelFilters(user.uid, (filters, synced) => {
        setChannelFilters(filters);
        setFiltersLoaded(true);
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

  const rememberVerdicts = useCallback((enriched: FeedItem[]) => {
    for (const item of enriched) {
      if (item.kind === "video" && typeof item.isShort === "boolean") {
        shortsVerdicts.current.set(item.videoId, item.isShort);
      }
    }
  }, []);

  /*
   * The videos whose Short-ness is worth knowing: only a channel that keeps or
   * drops Shorts consults the verdict, so the rest are never read or probed.
   * Includes the already-classified ones on purpose — a set that shrank as
   * verdicts landed would tear down and rebuild the listeners on every arrival.
   */
  const shortsCandidates = useMemo(() => {
    const ids = new Set<string>();
    for (const item of [...items, ...(channelItems?.items ?? [])]) {
      if (item.kind !== "video" || !isShortsCandidate(item)) {
        continue;
      }
      const channel = channels.get(item.channelId);
      if (channel && (channel.shortsFilter ?? "all") !== "all") {
        ids.add(item.videoId);
      }
    }
    return Array.from(ids).sort().join(",");
  }, [items, channelItems, channels]);

  // Watch the candidates whose verdict we don't know; creating a document is how
  // an unknown one is asked about. Verdicts patch the cards as they arrive.
  useEffect(() => {
    const candidates = shortsCandidates
      .split(",")
      .filter((videoId) => videoId && !shortsVerdicts.current.has(videoId));
    if (candidates.length === 0) {
      return;
    }
    return watchShortsVerdicts(candidates, (verdicts, missing) => {
      if (verdicts.size > 0) {
        for (const [videoId, isShort] of verdicts) {
          shortsVerdicts.current.set(videoId, isShort);
        }
        setItems((prev) => withVerdicts(prev, verdicts));
        setChannelItems((prev) =>
          prev ? { ...prev, items: withVerdicts(prev.items, verdicts) } : prev,
        );
        void cacheShortsVerdicts(user.uid, verdicts);
      }
      if (missing.length > 0) {
        void requestShortsClassification(missing);
      }
    });
  }, [shortsCandidates, user.uid]);

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
      const enriched = await enrichItems(
        user.uid,
        loaded.flat(),
        shortsVerdicts.current,
      );
      rememberVerdicts(enriched.items);
      return {
        subscriptions: Array.from(merged.keys()),
        watched: enriched.watched,
        items: enriched.items,
        partial: failed > 0,
      };
    },
    [user.uid, rememberVerdicts],
  );

  const loadFeed = useCallback(async () => {
    if (loadInFlight.current) {
      return;
    }
    loadInFlight.current = true;
    // taken before the reads, so a write acknowledged earlier is guaranteed to be
    // in what they return
    const startedAt = Date.now();
    setLoading(true);
    setError(null);
    let token: string;
    try {
      token = await getValidToken();
    } catch {
      onTokenLost();
      setError("Reconnect YouTube to load your feed.");
      setLoading(false);
      lastAttemptAt.current = Date.now();
      loadInFlight.current = false;
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
      // marks durable before this load read are already in `data`; the rest raced it
      prunePending(pendingWatched.current, startedAt);
      const loadedWatched = new Set(data.watched);
      const loadedHidden = new Set(data.watched);
      for (const [id, entry] of pendingWatched.current) {
        if (entry.value) {
          loadedWatched.add(id);
        } else {
          loadedWatched.delete(id);
        }
        // toggled during this load, so it stays on screen (dimmed) until the next
        // one, like any other in-session mark
        loadedHidden.delete(id);
      }
      setSubscriptions(data.subscriptions);
      setWatched(loadedWatched);
      setHiddenWatched(loadedHidden);
      setItems(data.items);
      feedApplied.current = true;
      // a partial load must not overwrite the good cache; surface a notice instead
      if (data.partial) {
        setNotice("Some channels couldn't be loaded; showing partial results.");
      } else {
        setNotice(null);
        void saveCachedFeed(user.uid, {
          subscriptions: data.subscriptions,
          watched: loadedWatched,
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
      // stamped on failure too, so a load that keeps failing isn't retried on
      // every return to the app
      lastAttemptAt.current = Date.now();
      loadInFlight.current = false;
    }
  }, [fetchEverything, onTokenLost, user.uid]);

  // Paint the cached feed immediately; the load below refreshes it underneath.
  useEffect(() => {
    let cancelled = false;
    void loadCachedFeed(user.uid).then((cached) => {
      if (cancelled) {
        return;
      }
      if (cached && !feedApplied.current) {
        setSubscriptions(cached.subscriptions);
        setWatched(cached.watched);
        setHiddenWatched(cached.watched);
        setItems(cached.items);
        rememberVerdicts(cached.items);
      }
      setHydrating(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user.uid, rememberVerdicts]);

  useEffect(() => {
    if (ready) {
      void loadFeed();
    }
  }, [ready, loadFeed]);

  // Refresh a stale feed on returning to the app. `focus` as well as
  // `visibilitychange` because switching windows doesn't change visibility.
  useEffect(() => {
    if (!ready) {
      return;
    }
    const refreshIfStale = () => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastAttemptAt.current >= REFRESH_STALE_MS
      ) {
        void loadFeed();
      }
    };
    document.addEventListener("visibilitychange", refreshIfStale);
    window.addEventListener("focus", refreshIfStale);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfStale);
      window.removeEventListener("focus", refreshIfStale);
    };
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
        const enriched = await enrichItems(
          user.uid,
          fetched,
          shortsVerdicts.current,
        );
        rememberVerdicts(enriched.items);
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
    rememberVerdicts,
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

  const persistWatched = useCallback(
    (id: string, isWatched: boolean) => {
      const entry = trackPending(pendingWatched.current, id, isWatched);
      settlePending(
        entry,
        isWatched ? markWatched(user.uid, id) : unmarkWatched(user.uid, id),
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
      persistWatched(id, !isWatched);
    },
    [persistWatched, watched],
  );

  // The player calls this when you leave a video (queue advance or close), so it
  // marks each in turn. Idempotent: a video already watched is left untouched.
  const markItemWatched = useCallback(
    (id: string) => {
      setWatched((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      persistWatched(id, true);
    },
    [persistWatched],
  );

  const feed = useMemo(() => {
    // Painting before the filters arrive would show every cached item, filtered by
    // nothing, for as long as Firestore's cache takes to answer — a channel page
    // has no `enabled` check to hide them behind.
    if (!filtersLoaded) {
      return [];
    }
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
    filtersLoaded,
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

      {(hydrating || !filtersLoaded || loading || checking) &&
      feed.length === 0 ? (
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
      {!hydrating &&
      filtersLoaded &&
      !loading &&
      !channelLoading &&
      ready &&
      feed.length === 0 ? (
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
