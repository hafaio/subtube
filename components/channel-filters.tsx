"use client";

import Image from "next/image";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { IconType } from "react-icons";
import { LuCaseLower, LuCaseSensitive } from "react-icons/lu";
import {
  MdArticle,
  MdAspectRatio,
  MdBlock,
  MdCheck,
  MdClose,
  MdCropLandscape,
  MdLiveTv,
  MdMovie,
  MdOndemandVideo,
  MdPlaylistPlay,
  MdSearch,
  MdStayCurrentPortrait,
  MdSubject,
  MdTitle,
  MdVideoLibrary,
} from "react-icons/md";
import { formatDuration } from "../src/duration";
import { feedItemId } from "../src/feed-item";
import { compileFilter, videoPassesFilter } from "../src/filters";
import { classifyShorts, SHORTS_MAX_SECONDS } from "../src/shorts";
import type {
  ChannelFilter,
  ContentMode,
  FeedItem,
  FilterMode,
  FilterScope,
  LiveFilter,
  ShortsFilter,
} from "../src/types";
import { fetchPlaylists, fetchUploads } from "../src/youtube";
import { getValidToken } from "../src/youtube-token";
import Toggle from "./toggle";

const TRANSITION_MS = 200;

export default function ChannelFilters({
  open,
  channels,
  latest,
  items,
  onChange,
  onOpenChannel,
  onClose,
  disabled = false,
}: {
  open: boolean;
  disabled?: boolean;
  channels: ChannelFilter[];
  // channelId -> most recent item publishedAt, for ordering.
  latest: Map<string, string>;
  items: FeedItem[];
  onChange: (filter: ChannelFilter) => void;
  onOpenChannel: (channelId: string) => void;
  onClose: () => void;
}): ReactElement | null {
  const [query, setQuery] = useState("");
  // `rendered` keeps the panel mounted through the exit animation; `shown` drives
  // the slide/fade so the panel can animate both in and out.
  const [rendered, setRendered] = useState(open);
  const [shown, setShown] = useState(false);
  // Which channel's regex tester is open. Held here (not in the row) so the modal
  // renders outside the panel's slide transform and can center on the viewport.
  const [testerChannelId, setTesterChannelId] = useState<string | null>(null);

  const itemsByChannel = useMemo(() => {
    const map = new Map<string, FeedItem[]>();
    for (const item of items) {
      const list = map.get(item.channelId);
      if (list) {
        list.push(item);
      } else {
        map.set(item.channelId, [item]);
      }
    }
    return map;
  }, [items]);

  useEffect(() => {
    if (open) {
      setRendered(true);
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = window.setTimeout(() => setRendered(false), TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!rendered) {
    return null;
  }

  const needle = query.trim().toLowerCase();
  const visible = [...channels]
    .filter(
      (channel) => !needle || channel.title.toLowerCase().includes(needle),
    )
    .sort((left, right) => {
      // Sort purely by most recent upload (then title), so toggling a channel's
      // enabled state doesn't make it jump position.
      const leftLatest = latest.get(left.channelId) ?? "";
      const rightLatest = latest.get(right.channelId) ?? "";
      if (leftLatest !== rightLatest) {
        return rightLatest.localeCompare(leftLatest);
      }
      return left.title.localeCompare(right.title);
    });

  const testerChannel = testerChannelId
    ? (channels.find((channel) => channel.channelId === testerChannelId) ??
      null)
    : null;

  return (
    <div className="fixed inset-0 z-20 flex justify-end">
      <button
        type="button"
        aria-label="Close channels"
        className={`absolute inset-0 cursor-default bg-black/60 transition-opacity duration-200 ${
          shown ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      <div
        className={`relative flex h-full w-full max-w-md flex-col bg-white transition-transform duration-200 ease-out dark:bg-slate-900 ${
          shown ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 border-slate-200 border-b p-4 dark:border-slate-800">
          <h2 className="font-bold text-lg">Channels</h2>
          <div className="relative ml-auto">
            <input
              className="w-28 min-w-0 rounded bg-slate-100 px-2 py-1 pr-6 text-sm dark:bg-slate-800"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                title="Clear search"
                aria-label="Clear search"
                className="-translate-y-1/2 absolute top-1/2 right-1 flex items-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <MdClose />
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="rounded px-2 py-1 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            onClick={onClose}
          >
            Done
          </button>
        </div>
        <div
          className={`flex-1 overflow-y-auto ${disabled ? "pointer-events-none opacity-60" : ""}`}
        >
          {visible.map((channel) => (
            <ChannelRow
              key={channel.channelId}
              channel={channel}
              onOpenTester={() => setTesterChannelId(channel.channelId)}
              onOpenChannel={() => onOpenChannel(channel.channelId)}
              onChange={onChange}
            />
          ))}
        </div>
      </div>
      {testerChannel ? (
        <RegexTester
          channel={testerChannel}
          items={itemsByChannel.get(testerChannel.channelId) ?? []}
          onChange={onChange}
          onClose={() => setTesterChannelId(null)}
        />
      ) : null}
    </div>
  );
}

const SCOPE_NEXT: Record<FilterScope, FilterScope> = {
  title: "both",
  both: "description",
  description: "title",
};
const SCOPE_LABEL: Record<FilterScope, string> = {
  title: "title",
  both: "title + description",
  description: "description",
};
const SCOPE_ICON: Record<FilterScope, IconType> = {
  title: MdTitle,
  both: MdArticle,
  description: MdSubject,
};

const LIVE_NEXT: Record<LiveFilter, LiveFilter> = {
  all: "vod",
  vod: "normal",
  normal: "all",
};
const LIVE_LABEL: Record<LiveFilter, string> = {
  all: "all videos",
  vod: "live & replays only",
  normal: "regular uploads only",
};
const LIVE_ICON: Record<LiveFilter, IconType> = {
  all: MdVideoLibrary,
  vod: MdLiveTv,
  normal: MdMovie,
};

const SHORTS_NEXT: Record<ShortsFilter, ShortsFilter> = {
  all: "normal",
  normal: "shorts",
  shorts: "all",
};
const SHORTS_LABEL: Record<ShortsFilter, string> = {
  all: "Shorts & videos",
  normal: "no Shorts",
  shorts: "Shorts only",
};
// Generic rectangle = both; landscape = no Shorts; portrait = Shorts only.
const SHORTS_ICON: Record<ShortsFilter, IconType> = {
  all: MdAspectRatio,
  normal: MdCropLandscape,
  shorts: MdStayCurrentPortrait,
};

const CONTENT_MODE_NEXT: Record<ContentMode, ContentMode> = {
  videos: "playlists",
  playlists: "videos",
};
const CONTENT_MODE_LABEL: Record<ContentMode, string> = {
  videos: "Showing uploads",
  playlists: "Showing playlists",
};
const CONTENT_MODE_ICON: Record<ContentMode, IconType> = {
  videos: MdOndemandVideo,
  playlists: MdPlaylistPlay,
};

const CONTROL_CLASS =
  "flex shrink-0 items-center rounded border border-slate-300 p-1 text-base text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800";

// Whether the channel feeds its uploads or its playlists — a per-channel setting
// (not a filter), so it sits by the enable switch and in the tester header.
function ContentModeToggle({
  channel,
  onChange,
}: {
  channel: ChannelFilter;
  onChange: (filter: ChannelFilter) => void;
}): ReactElement {
  const contentMode = channel.contentMode ?? "videos";
  const Icon = CONTENT_MODE_ICON[contentMode];
  return (
    <button
      type="button"
      onClick={() =>
        onChange({ ...channel, contentMode: CONTENT_MODE_NEXT[contentMode] })
      }
      title={`${CONTENT_MODE_LABEL[contentMode]} (click to switch)`}
      aria-label={CONTENT_MODE_LABEL[contentMode]}
      className={CONTROL_CLASS}
    >
      <Icon />
    </button>
  );
}

// Per-channel filter controls shared by the sidebar row and the tester modal:
// case sensitivity, include/exclude, and search scope — all icon buttons that
// switch glyph by state (no highlight) to match the rest of the UI.
function FilterControls({
  channel,
  onChange,
}: {
  channel: ChannelFilter;
  onChange: (filter: ChannelFilter) => void;
}): ReactElement {
  const caseSensitive = channel.caseSensitive ?? false;
  const scope = channel.searchScope ?? "title";
  const liveFilter = channel.liveFilter ?? "all";
  const shortsFilter = channel.shortsFilter ?? "all";
  // The broadcast/Shorts gates only make sense for individual videos.
  const isPlaylists = (channel.contentMode ?? "videos") === "playlists";
  const nextMode: FilterMode =
    channel.mode === "include" ? "exclude" : "include";
  const CaseIcon = caseSensitive ? LuCaseSensitive : LuCaseLower;
  const ModeIcon = channel.mode === "include" ? MdCheck : MdBlock;
  const ScopeIcon = SCOPE_ICON[scope];
  const LiveIcon = LIVE_ICON[liveFilter];
  const ShortsIcon = SHORTS_ICON[shortsFilter];
  return (
    <>
      <button
        type="button"
        onClick={() => onChange({ ...channel, caseSensitive: !caseSensitive })}
        aria-pressed={caseSensitive}
        title={
          caseSensitive
            ? "Case sensitive (click to ignore case)"
            : "Case insensitive (click to match case)"
        }
        className={CONTROL_CLASS}
      >
        <CaseIcon />
      </button>
      <button
        type="button"
        onClick={() => onChange({ ...channel, mode: nextMode })}
        title={`${channel.mode} matches (click to ${nextMode})`}
        aria-label={`${channel.mode} matches`}
        className={CONTROL_CLASS}
      >
        <ModeIcon />
      </button>
      <button
        type="button"
        onClick={() => onChange({ ...channel, searchScope: SCOPE_NEXT[scope] })}
        title={`Search: ${SCOPE_LABEL[scope]} (click to cycle)`}
        aria-label={`Search: ${SCOPE_LABEL[scope]}`}
        className={CONTROL_CLASS}
      >
        <ScopeIcon />
      </button>
      {isPlaylists ? null : (
        <>
          <button
            type="button"
            onClick={() =>
              onChange({ ...channel, liveFilter: LIVE_NEXT[liveFilter] })
            }
            title={`Show: ${LIVE_LABEL[liveFilter]} (click to cycle)`}
            aria-label={`Show: ${LIVE_LABEL[liveFilter]}`}
            className={CONTROL_CLASS}
          >
            <LiveIcon />
          </button>
          <button
            type="button"
            onClick={() =>
              onChange({ ...channel, shortsFilter: SHORTS_NEXT[shortsFilter] })
            }
            title={`Show: ${SHORTS_LABEL[shortsFilter]} (click to cycle)`}
            aria-label={`Show: ${SHORTS_LABEL[shortsFilter]}`}
            className={CONTROL_CLASS}
          >
            <ShortsIcon />
          </button>
        </>
      )}
    </>
  );
}

function ChannelRow({
  channel,
  onOpenTester,
  onOpenChannel,
  onChange,
}: {
  channel: ChannelFilter;
  onOpenTester: () => void;
  onOpenChannel: () => void;
  onChange: (filter: ChannelFilter) => void;
}): ReactElement {
  let regexError: string | null = null;
  if (channel.regex.trim()) {
    try {
      new RegExp(channel.regex);
    } catch (caught) {
      regexError = (caught as Error).message;
    }
  }

  // Dim the channel's details when disabled, but keep the toggle itself bright.
  const dim = channel.enabled ? "" : "opacity-50";

  return (
    <div className="flex gap-3 border-slate-200 border-b p-3 dark:border-slate-800">
      <button
        type="button"
        onClick={onOpenChannel}
        className="shrink-0"
        title={`View ${channel.title}`}
        aria-label={`View ${channel.title}`}
      >
        {channel.thumbnail ? (
          <Image
            src={channel.thumbnail}
            alt=""
            width={36}
            height={36}
            className={`h-9 w-9 rounded-full ${dim}`}
          />
        ) : (
          <div
            className={`h-9 w-9 rounded-full bg-slate-200 dark:bg-slate-700 ${dim}`}
          />
        )}
      </button>
      <div className="flex flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenChannel}
            title={`View ${channel.title}`}
            className={`min-w-0 flex-1 text-left font-medium text-sm hover:underline ${dim}`}
          >
            {channel.title}
          </button>
          <ContentModeToggle channel={channel} onChange={onChange} />
          <Toggle
            checked={channel.enabled}
            onChange={(enabled) => onChange({ ...channel, enabled })}
            label={`${channel.enabled ? "Disable" : "Enable"} ${channel.title}`}
          />
        </div>
        <div className={`flex flex-wrap gap-2 ${dim}`}>
          <input
            className="min-w-0 flex-1 basis-40 rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800"
            placeholder="title regex (optional)"
            value={channel.regex}
            onChange={(event) =>
              onChange({ ...channel, regex: event.target.value })
            }
          />
          <FilterControls channel={channel} onChange={onChange} />
          <button
            type="button"
            className="flex shrink-0 items-center rounded border border-slate-300 px-1.5 text-base text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            onClick={onOpenTester}
            title="Preview what matches"
            aria-label="Preview what matches"
          >
            <MdSearch />
          </button>
        </div>
        {regexError ? (
          <p className="text-red-600 text-xs dark:text-red-400">{regexError}</p>
        ) : null}
      </div>
    </div>
  );
}

// Show the start and end of a long description (hashtags/links often live at the
// end), eliding the middle.
const DESCRIPTION_EDGE = 160;
function describePreview(description: string): { head: string; tail: string } {
  const text = description.trim();
  if (text.length <= DESCRIPTION_EDGE * 2) {
    return { head: text, tail: "" };
  }
  return {
    head: text.slice(0, DESCRIPTION_EDGE),
    tail: text.slice(-DESCRIPTION_EDGE),
  };
}

// Wrap each regex match in the title with a YouTube-red highlight.
function highlightMatches(title: string, regex: RegExp | null): ReactNode {
  if (!regex) {
    return title;
  }
  const global = new RegExp(
    regex.source,
    regex.flags.includes("g") ? regex.flags : `${regex.flags}g`,
  );
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match = global.exec(title);
  while (match !== null) {
    const start = match.index;
    const text = match[0];
    if (text) {
      if (start > lastIndex) {
        parts.push(title.slice(lastIndex, start));
      }
      parts.push(
        <mark
          key={key++}
          className="rounded bg-red-600/30 text-inherit dark:bg-red-500/30"
        >
          {text}
        </mark>,
      );
      lastIndex = start + text.length;
    } else {
      // Avoid an infinite loop on a zero-width match.
      global.lastIndex += 1;
    }
    match = global.exec(title);
  }
  if (parts.length === 0) {
    return title;
  }
  if (lastIndex < title.length) {
    parts.push(title.slice(lastIndex));
  }
  return parts;
}

// Live preview of a channel's regex against its recent items (videos or
// playlists): matched text is highlighted (whatever the mode), and items the
// filter would hide are dimmed — so it's easy to spot a too-broad regex.
function RegexTester({
  channel,
  items,
  onChange,
  onClose,
}: {
  channel: ChannelFilter;
  items: FeedItem[];
  onChange: (filter: ChannelFilter) => void;
  onClose: () => void;
}): ReactElement {
  const isPlaylists = (channel.contentMode ?? "videos") === "playlists";
  const expectedKind = isPlaylists ? "playlist" : "video";
  // The feed may hold this channel's items from a previous mode (e.g. videos,
  // before it was switched to playlists), so only trust the ones of the kind we
  // now want; fall back to an on-demand fetch when there are none.
  const feedItems = items.filter((item) => item.kind === expectedKind);
  const [fetched, setFetched] = useState<FeedItem[] | null>(null);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // isShort for videos that arrived without it (on-demand fetches, or feed videos
  // whose probe earlier failed), filled in lazily via the mostly-cached backend.
  const [shortsOverlay, setShortsOverlay] = useState<Map<string, boolean>>(
    new Map(),
  );

  useEffect(() => {
    if (feedItems.length > 0) {
      return;
    }
    let cancelled = false;
    setLoadingVideos(true);
    setFetchError(null);
    void (async () => {
      try {
        const token = await getValidToken();
        const result = isPlaylists
          ? await fetchPlaylists(channel.channelId, channel.title, token)
          : await fetchUploads(channel.channelId, channel.title, token, 50);
        if (!cancelled) {
          setFetched(result);
        }
      } catch (caught) {
        if (!cancelled) {
          setFetchError((caught as Error).message);
        }
      } finally {
        if (!cancelled) {
          setLoadingVideos(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel.channelId, channel.title, feedItems.length, isPlaylists]);

  const compiled = compileFilter(channel);
  // Only show items of the wanted kind: feed items if present, else the
  // on-demand fetch (filtered too, so a stale fetch from the prior mode doesn't
  // flash through while the new one loads).
  const list =
    feedItems.length > 0
      ? feedItems
      : (fetched ?? []).filter((item) => item.kind === expectedKind);

  // Classify any Shorts candidates still missing isShort. classifyShorts is
  // cheap (one cached DB call for already-probed ids), so the Shorts preview
  // stays accurate even for on-demand fetches.
  const pendingShortIds = list
    .filter(
      (item) =>
        item.kind === "video" &&
        item.isShort === undefined &&
        !shortsOverlay.has(item.videoId) &&
        item.durationSeconds &&
        item.durationSeconds <= SHORTS_MAX_SECONDS,
    )
    .map(feedItemId);
  const pendingShortKey = pendingShortIds.join(",");
  useEffect(() => {
    if (!pendingShortKey) {
      return;
    }
    let cancelled = false;
    void classifyShorts(pendingShortKey.split(","))
      .then((result) => {
        if (!cancelled && result.size > 0) {
          setShortsOverlay((prev) => new Map([...prev, ...result]));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pendingShortKey]);
  const shownList: FeedItem[] = list.map((item) =>
    item.kind === "video" &&
    item.isShort === undefined &&
    shortsOverlay.has(item.videoId)
      ? { ...item, isShort: shortsOverlay.get(item.videoId) }
      : item,
  );

  // Highlight only the text the scope actually searches; show descriptions when
  // the scope includes them, so the builder reflects what's being matched.
  const titleRegex = compiled.scope === "description" ? null : compiled.regex;
  const showDescription = compiled.scope !== "title";
  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/60 p-4">
      <button
        type="button"
        aria-label="Close preview"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div className="relative flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg bg-white dark:bg-slate-900">
        <div className="flex flex-col gap-2 border-slate-200 border-b p-4 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium text-sm">
              {channel.title}
            </span>
            <ContentModeToggle channel={channel} onChange={onChange} />
            <button
              type="button"
              className="rounded px-2 py-1 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              onClick={onClose}
            >
              Done
            </button>
          </div>
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded bg-slate-100 px-2 py-1 text-sm dark:bg-slate-800"
              placeholder="title regex"
              value={channel.regex}
              onChange={(event) =>
                onChange({ ...channel, regex: event.target.value })
              }
            />
            <FilterControls channel={channel} onChange={onChange} />
          </div>
          {isPlaylists ? null : (
            <label className="flex items-center gap-2 text-slate-500 text-xs dark:text-slate-400">
              Hide videos under
              <input
                type="number"
                min={0}
                value={channel.minDurationSeconds || ""}
                placeholder="0"
                onChange={(event) =>
                  onChange({
                    ...channel,
                    minDurationSeconds: Math.max(
                      0,
                      Math.floor(Number(event.target.value)) || 0,
                    ),
                  })
                }
                className="w-16 rounded bg-slate-100 px-2 py-1 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
              />
              seconds
            </label>
          )}
          {compiled.error ? (
            <p className="text-red-600 text-xs dark:text-red-400">
              {compiled.error}
            </p>
          ) : null}
        </div>
        <div className="flex-1 overflow-y-auto">
          {loadingVideos ? (
            <div className="grid place-items-center p-10">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-500 dark:border-slate-700 dark:border-t-slate-300" />
            </div>
          ) : fetchError ? (
            <p className="p-6 text-center text-red-600 text-sm dark:text-red-400">
              {fetchError}
            </p>
          ) : shownList.length === 0 ? (
            <p className="p-6 text-center text-slate-500 text-sm dark:text-slate-400">
              Nothing to preview for this channel.
            </p>
          ) : (
            shownList.map((item) => {
              const kept = videoPassesFilter(item, compiled);
              const description = showDescription
                ? describePreview(item.description)
                : null;
              return (
                <div
                  key={feedItemId(item)}
                  className={`flex items-start gap-3 border-slate-100 border-b p-2 dark:border-slate-800 ${
                    kept ? "" : "opacity-40"
                  }`}
                >
                  <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
                    {item.thumbnail ? (
                      <Image
                        src={item.thumbnail}
                        alt=""
                        fill
                        sizes="96px"
                        className="object-cover"
                      />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      {highlightMatches(item.title, titleRegex)}
                    </p>
                    {item.kind === "playlist" ? (
                      <p className="mt-0.5 flex items-center gap-1 text-slate-400 text-xs dark:text-slate-500">
                        <MdPlaylistPlay className="text-sm" />
                        {item.itemCount} videos
                      </p>
                    ) : item.durationSeconds || item.isShort ? (
                      <p className="mt-0.5 flex items-center gap-1.5 text-slate-400 text-xs dark:text-slate-500">
                        {item.durationSeconds
                          ? formatDuration(item.durationSeconds)
                          : null}
                        {item.isShort ? (
                          <span className="rounded bg-red-600 px-1 font-medium text-white">
                            Short
                          </span>
                        ) : null}
                      </p>
                    ) : null}
                    {description?.head ? (
                      <p className="mt-0.5 text-slate-500 text-xs dark:text-slate-400">
                        {highlightMatches(description.head, compiled.regex)}
                        {description.tail ? (
                          <>
                            {" … "}
                            {highlightMatches(description.tail, compiled.regex)}
                          </>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
