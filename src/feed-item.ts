import type { FeedItem } from "./types";

// The stable id for a feed entry — its video id or playlist id. Used as the key
// for rendering, watched-state, and de-duplication.
export function feedItemId(item: FeedItem): string {
  return item.kind === "playlist" ? item.playlistId : item.videoId;
}
