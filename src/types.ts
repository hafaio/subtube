export type FilterMode = "include" | "exclude";
// What the per-channel regex matches against.
export type FilterScope = "title" | "both" | "description";
// Whether a channel contributes its uploads or its playlists to the feed.
export type ContentMode = "videos" | "playlists";
// A video's broadcast kind. "vod" is a finished live stream or premiere;
// "normal" is a plain upload that was never broadcast.
export type LiveStatus = "upcoming" | "live" | "vod" | "normal";
// Per-channel broadcast filter. "all" keeps everything but upcoming; "vod" keeps
// only live streams and their replays; "normal" keeps only plain uploads.
export type LiveFilter = "all" | "vod" | "normal";
// Per-channel Shorts filter. "all" keeps everything; "normal" hides Shorts;
// "shorts" keeps only Shorts.
export type ShortsFilter = "all" | "normal" | "shorts";

export interface Subscription {
  channelId: string;
  title: string;
  thumbnail: string;
}

export interface ChannelFilter {
  channelId: string;
  title: string;
  thumbnail: string;
  enabled: boolean;
  // Empty string means "no title filter"; otherwise a JS regex source string.
  regex: string;
  // include: keep videos whose title matches; exclude: keep videos that do not.
  mode: FilterMode;
  // Default (undefined/false) is case-insensitive matching.
  caseSensitive?: boolean;
  // What the regex matches against; default (undefined) is the title only.
  searchScope?: FilterScope;
  // Hide videos shorter than this many seconds; 0/undefined disables it.
  minDurationSeconds?: number;
  // Which broadcast kinds to keep; default (undefined) is "all".
  liveFilter?: LiveFilter;
  // Which Shorts/normal videos to keep; default (undefined) is "all".
  shortsFilter?: ShortsFilter;
  // Whether the channel shows its uploads or its playlists; default is "videos".
  contentMode?: ContentMode;
}

export interface Video {
  kind: "video";
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnail: string;
  // Length in seconds; 0/undefined for live or upcoming (no duration).
  durationSeconds?: number;
  // Broadcast kind; undefined (e.g. older cached videos) is treated as "normal".
  liveStatus?: LiveStatus;
  // Whether this is a YouTube Short; undefined means not yet classified.
  isShort?: boolean;
}

export interface Playlist {
  kind: "playlist";
  playlistId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  description: string;
  // Playlist creation time — used for feed ordering (good for episode-per-
  // playlist channels like SNL; imperfect for long-lived appended playlists).
  publishedAt: string;
  thumbnail: string;
  itemCount: number;
}

// A feed entry: either a single video or a whole playlist, depending on the
// channel's content mode. Both share the fields the feed sorts/filters on.
export type FeedItem = Video | Playlist;
