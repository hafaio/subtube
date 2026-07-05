import { describe, expect, test } from "bun:test";
import { buildPlayQueue } from "./queue";
import type { FeedItem, Playlist, Video } from "./types";

function video(id: string): Video {
  return {
    kind: "video",
    videoId: id,
    channelId: "UC1",
    channelTitle: "Chan",
    title: id,
    description: "",
    publishedAt: "2026-01-01T00:00:00Z",
    thumbnail: "",
  };
}

function playlist(id: string): Playlist {
  return {
    kind: "playlist",
    playlistId: id,
    channelId: "UC1",
    channelTitle: "Chan",
    title: id,
    description: "",
    publishedAt: "2026-01-01T00:00:00Z",
    thumbnail: "",
    itemCount: 1,
  };
}

describe("buildPlayQueue", () => {
  test("keeps unwatched videos in order, each marking itself", () => {
    const items: FeedItem[] = [video("a"), video("b")];
    const { videoIds, marks } = buildPlayQueue(items, new Set(), new Map());
    expect(videoIds).toEqual(["a", "b"]);
    expect(marks).toEqual(
      new Map([
        ["a", "a"],
        ["b", "b"],
      ]),
    );
  });

  test("drops watched videos and watched (completed) playlists", () => {
    const items: FeedItem[] = [video("a"), playlist("PL1"), video("b")];
    const playlistIds = new Map([["PL1", ["x", "y"]]]);
    const { videoIds } = buildPlayQueue(
      items,
      new Set(["a", "PL1"]),
      playlistIds,
    );
    expect(videoIds).toEqual(["b"]);
  });

  test("inlines a playlist's videos, marking only the playlist on its last", () => {
    const items: FeedItem[] = [video("a"), playlist("PL1")];
    const playlistIds = new Map([["PL1", ["x", "y", "z"]]]);
    const { videoIds, marks } = buildPlayQueue(items, new Set(), playlistIds);
    expect(videoIds).toEqual(["a", "x", "y", "z"]);
    // a -> itself; the playlist's final video -> the playlist; x and y unmarked.
    expect(marks).toEqual(
      new Map([
        ["a", "a"],
        ["z", "PL1"],
      ]),
    );
    expect(marks.has("x")).toBe(false);
    expect(marks.has("y")).toBe(false);
  });

  test("skips a playlist with no playable videos", () => {
    const items: FeedItem[] = [playlist("PL1"), video("a")];
    const { videoIds } = buildPlayQueue(
      items,
      new Set(),
      new Map([["PL1", []]]),
    );
    expect(videoIds).toEqual(["a"]);
  });

  test("caps the queue at max, stopping once it's full", () => {
    const items: FeedItem[] = [video("a"), video("b"), video("c")];
    const { videoIds } = buildPlayQueue(items, new Set(), new Map(), 2);
    expect(videoIds).toEqual(["a", "b"]);
  });

  test("skips a playlist that wouldn't fit whole, keeping its mark reachable", () => {
    const items: FeedItem[] = [video("a"), playlist("PL1"), video("b")];
    const playlistIds = new Map([["PL1", ["x", "y", "z"]]]);
    // budget of 2: "a" fits, PL1 (3 ids) doesn't fit and is skipped, "b" still fits; PL1's mark stays reachable
    const { videoIds, marks } = buildPlayQueue(
      items,
      new Set(),
      playlistIds,
      2,
    );
    expect(videoIds).toEqual(["a", "b"]);
    expect(marks.has("z")).toBe(false);
  });
});
