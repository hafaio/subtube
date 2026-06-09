"use client";

import { type ReactElement, useEffect, useRef } from "react";

// Minimal typings for the subset of the YouTube IFrame Player API we use.
interface VideoData {
  video_id?: string;
}

interface YouTubePlayer {
  destroy(): void;
  getIframe(): HTMLIFrameElement;
  // Loads and plays an arbitrary list of video ids in order, starting at `index`.
  loadPlaylist?(
    playlist: string[],
    index?: number,
    startSeconds?: number,
  ): void;
  // Undocumented but long-stable; reports the currently playing video so we can
  // tell when an auto-advancing queue has moved on to the next one.
  getVideoData?(): VideoData;
  // The ids the player actually loaded for a playlist, and the current position
  // within them — used to spot when the final video of a playlist has ended.
  getPlaylist?(): string[] | null;
  getPlaylistIndex?(): number;
}

interface PlayerStateChangeEvent {
  data: number;
  target: YouTubePlayer;
}

interface PlayerReadyEvent {
  target: YouTubePlayer;
}

interface YouTubeNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      videoId?: string;
      width?: string | number;
      height?: string | number;
      // `list`/`listType`/`playlist` are strings, so this is widened from
      // number-only.
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: PlayerReadyEvent) => void;
        onStateChange?: (event: PlayerStateChangeEvent) => void;
      };
    },
  ) => YouTubePlayer;
  PlayerState: { PLAYING: number; ENDED: number };
}

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;

function loadIframeApi(): Promise<void> {
  if (window.YT?.Player) {
    return Promise.resolve();
  }
  if (apiPromise) {
    return apiPromise;
  }
  apiPromise = new Promise<void>((resolve) => {
    const priorCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      priorCallback?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });
  return apiPromise;
}

// Embeds the official IFrame player (so ads serve and views count) and marks
// videos watched as you LEAVE them: when an auto-advancing queue moves to the
// next video the previous one is marked, and closing the player marks whatever
// is playing. A bare open that never reaches playback marks nothing — and so
// does abandoning the tab without closing (only the close/Back path unmounts and
// fires the cleanup). A `video` plays a list of ids end-to-end — one id for a
// single card, or the whole unwatched queue from "Play all"; a `playlist` plays
// a real YouTube playlist and is marked as a whole only once its last video
// finishes — closing it early leaves it unwatched (its inner videos aren't feed
// entries, so they're never marked individually).
type PlayerProps = {
  onClose: () => void;
  onWatched: (id: string) => void;
} & (
  | {
      kind: "video";
      videoIds: string[];
      // What to mark when leaving each video. Absent → mark the video itself
      // (single clicks, plain queues). Present → look it up, marking nothing for
      // videos not in the map (a "Play all" queue's inlined playlist videos,
      // where only the last one marks its playlist).
      marks?: Map<string, string>;
      playlistId?: undefined;
    }
  | {
      kind: "playlist";
      playlistId: string;
      videoIds?: undefined;
      marks?: undefined;
    }
);

export default function Player(props: PlayerProps): ReactElement {
  const { onClose, onWatched } = props;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const onWatchedRef = useRef(onWatched);
  onWatchedRef.current = onWatched;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Capture the queue/playlist once, on first render. A later feed refresh (or
  // the queue marking videos watched as it plays) changes these props, but must
  // not reshape or restart playback — the parent gives this component a `key`
  // tied to the route, so opening a different item remounts it from scratch.
  const initRef = useRef<{
    kind: "video" | "playlist";
    videoIds: string[];
    marks: Map<string, string> | null;
    playlistId: string;
  } | null>(null);
  if (initRef.current === null) {
    initRef.current = {
      kind: props.kind,
      videoIds: props.kind === "video" ? props.videoIds : [],
      marks: props.kind === "video" ? (props.marks ?? null) : null,
      playlistId: props.kind === "playlist" ? props.playlistId : "",
    };
  }

  // Escape closes the player. Note: once the (cross-origin) iframe has focus it
  // swallows keystrokes, so this fires mainly before you click into the video;
  // clicking the backdrop is the reliable close otherwise.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const snapshot = initRef.current;
    if (!snapshot) {
      return;
    }
    const { kind, videoIds: queue, marks, playlistId } = snapshot;
    // What to mark when leaving `videoId`: a remapped id (queue with playlists),
    // the video itself (no map), or nothing (a non-final inlined playlist video).
    const markFor = (videoId: string): string | undefined =>
      marks ? marks.get(videoId) : videoId;
    let player: YouTubePlayer | null = null;
    let host: HTMLDivElement | null = null;
    let cancelled = false;
    // Whether playback ever started — a bare open that never plays marks nothing.
    let started = false;
    // The video currently playing (for a queue); null for a real playlist, whose
    // inner videos we don't track.
    let currentVideoId: string | null =
      kind === "video" ? (queue[0] ?? null) : null;

    void loadIframeApi().then(() => {
      const namespace = window.YT;
      if (cancelled || !namespace || !wrapperRef.current) {
        return;
      }
      host = document.createElement("div");
      wrapperRef.current.appendChild(host);
      player = new namespace.Player(host, {
        width: "100%",
        height: "100%",
        // A real playlist loads via listType/list; a video queue is loaded from
        // its id array in onReady (combining videoId with the `playlist` param
        // unreliably drops the first id).
        ...(kind === "playlist"
          ? {
              playerVars: {
                autoplay: 1,
                rel: 0,
                listType: "playlist",
                list: playlistId,
              },
            }
          : { playerVars: { rel: 0 } }),
        events: {
          onReady: (event) => {
            if (cancelled) {
              return;
            }
            // loadPlaylist plays the whole id list from the top, auto-advancing.
            if (kind === "video") {
              event.target.loadPlaylist?.(queue, 0);
            }
            // Focus the iframe so the player's keyboard shortcuts (space, arrows,
            // f, m, …) work immediately, without a click into the video first.
            event.target.getIframe().focus({ preventScroll: true });
          },
          onStateChange: (event) => {
            if (event.data === namespace.PlayerState.PLAYING) {
              started = true;
            }
            if (kind === "playlist") {
              // Mark the whole playlist watched once its final video ends.
              // getPlaylist() is what the player actually loaded (auto-advance
              // already skipped any unavailable videos), so the last index is
              // the true end of the playlist.
              const playlist = event.target.getPlaylist?.();
              if (
                event.data === namespace.PlayerState.ENDED &&
                playlist &&
                event.target.getPlaylistIndex?.() === playlist.length - 1
              ) {
                onWatchedRef.current(playlistId);
              }
              return;
            }
            // The queue auto-advanced: mark the video we just left, then track
            // the new one (marked in turn when it's left or on close).
            const nextId = event.target.getVideoData?.().video_id;
            if (nextId && nextId !== currentVideoId) {
              const markId =
                currentVideoId && started && markFor(currentVideoId);
              if (markId) {
                onWatchedRef.current(markId);
              }
              currentVideoId = nextId;
            }
          },
        },
      });
    });

    return () => {
      cancelled = true;
      // Closing marks the video you're on (single or queue), provided playback
      // started. A native playlist is marked only on finishing (handled above),
      // so closing it early intentionally leaves it unwatched.
      const markId =
        started &&
        kind === "video" &&
        currentVideoId &&
        markFor(currentVideoId);
      if (markId) {
        onWatchedRef.current(markId);
      }
      player?.destroy();
      host?.remove();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-black/80 p-4">
      <button
        type="button"
        aria-label="Close player"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div className="relative w-full max-w-4xl">
        <div
          className="aspect-video w-full overflow-hidden rounded-lg bg-black"
          ref={wrapperRef}
        />
      </div>
    </div>
  );
}
