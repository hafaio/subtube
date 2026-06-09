import { feedItemId } from "./feed-item";
import type { FeedItem } from "./types";

export interface PlayQueue {
  // The video ids to play end-to-end, in feed order, with each unwatched
  // playlist expanded inline into its videos.
  videoIds: string[];
  // What to mark watched when the player leaves a given video: the video itself
  // for a standalone feed video, or the playlist id for the final video of an
  // inlined playlist. A playlist's non-final videos are absent — they aren't
  // feed entries, so they're never marked.
  marks: Map<string, string>;
}

// Build the "Play all" queue from the currently visible feed: every unwatched
// item, in order, with playlists inlined from `playlistVideoIds` (fetched
// separately, since expanding a playlist needs the API). Watched items — videos
// or already-completed playlists — are skipped.
export function buildPlayQueue(
  items: FeedItem[],
  watched: Set<string>,
  playlistVideoIds: Map<string, string[]>,
): PlayQueue {
  const videoIds: string[] = [];
  const marks = new Map<string, string>();
  for (const item of items) {
    if (watched.has(feedItemId(item))) {
      continue;
    }
    if (item.kind === "video") {
      videoIds.push(item.videoId);
      marks.set(item.videoId, item.videoId);
    } else {
      const ids = playlistVideoIds.get(item.playlistId) ?? [];
      if (ids.length === 0) {
        continue;
      }
      videoIds.push(...ids);
      // Leaving the playlist's last video means it played through — mark the
      // playlist complete (its inner videos stay unmarked).
      marks.set(ids[ids.length - 1], item.playlistId);
    }
  }
  return { videoIds, marks };
}
