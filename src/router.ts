"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// What the player is showing, layered over the background: a single video, a
// real playlist, or the "queue" — every unwatched video in the current
// background played end-to-end (its contents are derived from the feed, so the
// route carries only the marker).
export type RouteItem =
  | { kind: "video"; id: string }
  | { kind: "playlist"; id: string }
  | { kind: "queue" };

// The app is a single static page (output: "export"), and ids are
// per-user/unbounded, so state lives in the query string: an optional `channel`
// background (a channel page; otherwise the feed) plus an optional open `item`
// (a video/playlist player layered on top). Opening a video from a channel page
// keeps both, so the channel stays behind the modal.
export interface Route {
  channel: string | null;
  item: RouteItem | null;
}

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  // An empty/missing channel param is simply no channel (feed background).
  const channel = params.get("channel") || null;
  const video = params.get("v");
  const playlist = params.get("list");
  const item: RouteItem | null = video
    ? { kind: "video", id: video }
    : playlist
      ? { kind: "playlist", id: playlist }
      : params.has("queue")
        ? { kind: "queue" }
        : null;
  return { channel, item };
}

function routeToUrl(route: Route): string {
  // Keep the current path so any basePath / trailing slash is preserved.
  const path = window.location.pathname;
  const params = new URLSearchParams();
  if (route.channel) {
    params.set("channel", route.channel);
  }
  if (route.item?.kind === "video") {
    params.set("v", route.item.id);
  } else if (route.item?.kind === "playlist") {
    params.set("list", route.item.id);
  } else if (route.item?.kind === "queue") {
    params.set("queue", "1");
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * URL-as-state: `open` pushes a history entry (so it feels like a new page and
 * Back returns), `close` pops the open item while keeping the channel background.
 * A deep-linked route with nothing of ours behind it closes by stripping the
 * item rather than leaving the site.
 */
export function useRoute(): {
  route: Route;
  open: (route: Route) => void;
  close: () => void;
} {
  const [search, setSearch] = useState(() =>
    typeof window === "undefined" ? "" : window.location.search,
  );
  const pushed = useRef(0);

  useEffect(() => {
    const onPopState = () => {
      pushed.current = Math.max(0, pushed.current - 1);
      setSearch(window.location.search);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const open = useCallback((route: Route) => {
    window.history.pushState(null, "", routeToUrl(route));
    pushed.current += 1;
    setSearch(window.location.search);
  }, []);

  const close = useCallback(() => {
    if (pushed.current > 0) {
      window.history.back();
    } else {
      const { channel } = parseRoute(window.location.search);
      window.history.replaceState(
        null,
        "",
        routeToUrl({ channel, item: null }),
      );
      setSearch(window.location.search);
    }
  }, []);

  return { route: parseRoute(search), open, close };
}
