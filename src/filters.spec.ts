import { describe, expect, test } from "bun:test";
import { compileFilter, videoPassesFilter } from "./filters";
import type { ChannelFilter, FeedItem, Playlist, Video } from "./types";

function channel(overrides: Partial<ChannelFilter> = {}): ChannelFilter {
  return {
    channelId: "UC1",
    title: "Chan",
    thumbnail: "",
    enabled: true,
    regex: "",
    mode: "include",
    ...overrides,
  };
}

function video(overrides: Partial<Video> = {}): Video {
  return {
    kind: "video",
    videoId: "v1",
    channelId: "UC1",
    channelTitle: "Chan",
    title: "Hello World",
    description: "",
    publishedAt: "2026-01-01T00:00:00Z",
    thumbnail: "",
    durationSeconds: 600,
    liveStatus: "normal",
    ...overrides,
  };
}

function playlist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    kind: "playlist",
    playlistId: "PL1",
    channelId: "UC1",
    channelTitle: "Chan",
    title: "Episode 1",
    description: "",
    publishedAt: "2026-01-01T00:00:00Z",
    thumbnail: "",
    itemCount: 5,
    ...overrides,
  };
}

const passes = (item: FeedItem, ch: ChannelFilter): boolean =>
  videoPassesFilter(item, compileFilter(ch));

describe("compileFilter", () => {
  test("empty regex compiles to no regex", () => {
    expect(compileFilter(channel()).regex).toBeNull();
  });

  test("invalid regex reports an error and no regex", () => {
    const compiled = compileFilter(channel({ regex: "(" }));
    expect(compiled.regex).toBeNull();
    expect(compiled.error).not.toBeNull();
  });

  test("case-insensitive by default, sensitive when set", () => {
    expect(compileFilter(channel({ regex: "a" })).regex?.flags).toBe("i");
    expect(
      compileFilter(channel({ regex: "a", caseSensitive: true })).regex?.flags,
    ).toBe("");
  });
});

describe("videoPassesFilter — regex", () => {
  test("include keeps matches and drops non-matches", () => {
    expect(passes(video({ title: "cats" }), channel({ regex: "cat" }))).toBe(
      true,
    );
    expect(passes(video({ title: "dogs" }), channel({ regex: "cat" }))).toBe(
      false,
    );
  });

  test("exclude inverts the match", () => {
    expect(
      passes(
        video({ title: "cats" }),
        channel({ regex: "cat", mode: "exclude" }),
      ),
    ).toBe(false);
  });

  test("description scope matches the description, not the title", () => {
    const ch = channel({ regex: "secret", searchScope: "description" });
    expect(passes(video({ title: "secret", description: "" }), ch)).toBe(false);
    expect(passes(video({ title: "", description: "a secret" }), ch)).toBe(
      true,
    );
  });

  test("no regex keeps everything", () => {
    expect(passes(video(), channel())).toBe(true);
  });
});

describe("videoPassesFilter — video-only gates", () => {
  test("minimum duration drops shorter videos", () => {
    const ch = channel({ minDurationSeconds: 120 });
    expect(passes(video({ durationSeconds: 60 }), ch)).toBe(false);
    expect(passes(video({ durationSeconds: 600 }), ch)).toBe(true);
  });

  test("upcoming is always hidden", () => {
    expect(passes(video({ liveStatus: "upcoming" }), channel())).toBe(false);
  });

  test("liveFilter vod keeps vod/live and drops normal", () => {
    const ch = channel({ liveFilter: "vod" });
    expect(passes(video({ liveStatus: "vod" }), ch)).toBe(true);
    expect(passes(video({ liveStatus: "normal" }), ch)).toBe(false);
  });

  test("liveFilter normal drops vod", () => {
    const ch = channel({ liveFilter: "normal" });
    expect(passes(video({ liveStatus: "vod" }), ch)).toBe(false);
    expect(passes(video({ liveStatus: "normal" }), ch)).toBe(true);
  });

  test("shortsFilter narrows to/away from Shorts", () => {
    expect(
      passes(video({ isShort: true }), channel({ shortsFilter: "normal" })),
    ).toBe(false);
    expect(
      passes(video({ isShort: true }), channel({ shortsFilter: "shorts" })),
    ).toBe(true);
    expect(
      passes(video({ isShort: false }), channel({ shortsFilter: "shorts" })),
    ).toBe(false);
  });
});

describe("videoPassesFilter — playlists", () => {
  test("playlists skip video-only gates but still match the title regex", () => {
    const ch = channel({
      minDurationSeconds: 9999,
      liveFilter: "vod",
      shortsFilter: "shorts",
      regex: "Episode",
    });
    expect(passes(playlist({ title: "Episode 1" }), ch)).toBe(true);
    expect(passes(playlist({ title: "Trailer" }), ch)).toBe(false);
  });
});
