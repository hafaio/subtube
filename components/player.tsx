"use client";

import { type ReactElement, useEffect, useRef } from "react";

// Minimal typings for the subset of the YouTube IFrame Player API we use.
interface YouTubePlayer {
  destroy(): void;
  getIframe(): HTMLIFrameElement;
}

interface PlayerStateChangeEvent {
  data: number;
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
      // `list`/`listType` are strings, so this is widened from number-only.
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (event: PlayerReadyEvent) => void;
        onStateChange?: (event: PlayerStateChangeEvent) => void;
      };
    },
  ) => YouTubePlayer;
  PlayerState: { PLAYING: number };
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

// Embeds the official IFrame player (so ads serve and views count) and marks the
// item watched the first time playback actually starts. A playlist loads the
// whole playlist (native next/prev, auto-advance); a video loads just it. Driven
// by kind+id (not a feed item) so a deep-linked URL can play something that
// isn't in the loaded feed.
export default function Player({
  kind,
  id,
  onClose,
  onPlay,
}: {
  kind: "video" | "playlist";
  id: string;
  onClose: () => void;
  onPlay: () => void;
}): ReactElement {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const onPlayRef = useRef(onPlay);
  onPlayRef.current = onPlay;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
    let player: YouTubePlayer | null = null;
    let host: HTMLDivElement | null = null;
    let cancelled = false;
    let marked = false;

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
        ...(kind === "playlist"
          ? {
              playerVars: {
                autoplay: 1,
                rel: 0,
                listType: "playlist",
                list: id,
              },
            }
          : { videoId: id, playerVars: { autoplay: 1, rel: 0 } }),
        events: {
          // Focus the iframe so the player's keyboard shortcuts (space, arrows,
          // f, m, …) work immediately, without a click into the video first.
          onReady: (event) => {
            if (!cancelled) {
              event.target.getIframe().focus({ preventScroll: true });
            }
          },
          onStateChange: (event) => {
            if (event.data === namespace.PlayerState.PLAYING && !marked) {
              marked = true;
              onPlayRef.current();
            }
          },
        },
      });
    });

    return () => {
      cancelled = true;
      player?.destroy();
      host?.remove();
    };
  }, [kind, id]);

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
