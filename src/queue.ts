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

// the IFrame player truncates a loaded queue past this many ids, so cap here too (else a playlist past the cutoff loses its mark)
export const MAX_QUEUE = 200;

/**
 * Build the "Play all" queue from the currently visible feed: every unwatched
 * item, in order, with playlists inlined from `playlistVideoIds` (fetched
 * separately, since expanding a playlist needs the API). Watched items — videos
 * or already-completed playlists — are skipped. Once the 200-id cap is reached
 * no further items are added; a playlist that wouldn't fit whole is skipped
 * (rather than truncated) so its final video, which carries the mark, is never
 * left out of reach.
 */
export function buildPlayQueue(
  items: FeedItem[],
  watched: Set<string>,
  playlistVideoIds: Map<string, string[]>,
  max = MAX_QUEUE,
): PlayQueue {
  const videoIds: string[] = [];
  const marks = new Map<string, string>();
  for (const item of items) {
    if (watched.has(feedItemId(item))) {
      continue;
    }
    const remaining = max - videoIds.length;
    if (remaining <= 0) {
      break;
    }
    if (item.kind === "video") {
      videoIds.push(item.videoId);
      marks.set(item.videoId, item.videoId);
    } else {
      const ids = playlistVideoIds.get(item.playlistId) ?? [];
      if (ids.length === 0 || ids.length > remaining) {
        // empty or wouldn't fit whole — skip so its mark stays reachable; a later item may still fit
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
