import type { FeedItem } from "./types";

/**
 * The stable id for a feed entry — its video id or playlist id. Used as the key
 * for rendering, watched-state, and de-duplication.
 */
export function feedItemId(item: FeedItem): string {
  return item.kind === "playlist" ? item.playlistId : item.videoId;
}

/** Apply arriving Shorts verdicts to a list, reusing it if nothing changed. */
export function withVerdicts(
  items: FeedItem[],
  verdicts: Map<string, boolean>,
): FeedItem[] {
  let changed = false;
  const patched = items.map((item) => {
    if (item.kind !== "video") {
      return item;
    }
    const isShort = verdicts.get(item.videoId);
    if (isShort === undefined || isShort === item.isShort) {
      return item;
    }
    changed = true;
    return { ...item, isShort };
  });
  return changed ? patched : items;
}
