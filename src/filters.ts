import type {
  ChannelFilter,
  FeedItem,
  FilterMode,
  FilterScope,
  LiveFilter,
  ShortsFilter,
} from "./types";

export interface CompiledFilter {
  enabled: boolean;
  regex: RegExp | null;
  mode: FilterMode;
  scope: FilterScope;
  minDurationSeconds: number;
  liveFilter: LiveFilter;
  shortsFilter: ShortsFilter;
  error: string | null;
}

export function compileFilter(filter: ChannelFilter): CompiledFilter {
  const scope: FilterScope = filter.searchScope ?? "title";
  const base = {
    enabled: filter.enabled,
    mode: filter.mode,
    scope,
    minDurationSeconds: filter.minDurationSeconds ?? 0,
    liveFilter: filter.liveFilter ?? "all",
    shortsFilter: filter.shortsFilter ?? "all",
  };
  if (!filter.regex.trim()) {
    return { ...base, regex: null, error: null };
  }
  try {
    const flags = filter.caseSensitive ? "" : "i";
    return { ...base, regex: new RegExp(filter.regex, flags), error: null };
  } catch (caught) {
    return { ...base, regex: null, error: (caught as Error).message };
  }
}

export function videoPassesFilter(
  item: FeedItem,
  compiled: CompiledFilter,
): boolean {
  const { regex, mode, scope, minDurationSeconds, liveFilter, shortsFilter } =
    compiled;
  // The broadcast/Shorts/duration gates are video-only; playlists skip them.
  // (Treat a missing kind — e.g. an older cached video — as a video.)
  if (item.kind !== "playlist") {
    // Shorts gate: keep only Shorts, only non-Shorts, or everything. A video with
    // no verdict (not classified yet, or the probe gave up) passes either way —
    // the gate can only act on what's known, and a video nobody can classify must
    // not vanish from the feed.
    if (item.isShort !== undefined) {
      if (shortsFilter === "normal" && item.isShort) {
        return false;
      }
      if (shortsFilter === "shorts" && !item.isShort) {
        return false;
      }
    }
    // Broadcast gate. Upcoming videos are always hidden; otherwise keep only the
    // kinds the channel's live filter allows.
    const status = item.liveStatus ?? "normal";
    if (status === "upcoming") {
      return false;
    }
    if (liveFilter === "vod" && status === "normal") {
      return false;
    }
    if (liveFilter === "normal" && status !== "normal") {
      return false;
    }
    // Duration gate, independent of the regex. Videos with an unknown duration
    // (0, e.g. live/upcoming) are kept.
    if (
      minDurationSeconds > 0 &&
      item.durationSeconds &&
      item.durationSeconds < minDurationSeconds
    ) {
      return false;
    }
  }
  if (!regex) {
    return true;
  }
  // Test the title and description independently and OR them, rather than
  // matching against a concatenation (which could match across the boundary).
  const matches =
    (scope !== "description" && regex.test(item.title)) ||
    (scope !== "title" && regex.test(item.description));
  return mode === "include" ? matches : !matches;
}
