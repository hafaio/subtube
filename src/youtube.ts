import { decodeHtmlEntities } from "./html";
import type { LiveStatus, Playlist, Subscription, Video } from "./types";

const API_BASE = "https://www.googleapis.com/youtube/v3";

export class TokenExpiredError extends Error {
  constructor() {
    super("YouTube access token expired or missing");
    this.name = "TokenExpiredError";
  }
}

// The token is valid but was granted without youtube.readonly — i.e. the user
// signed in but skipped the YouTube permission. Recoverable by re-consenting.
export class InsufficientScopeError extends Error {
  constructor() {
    super("YouTube access was granted without the read permission");
    this.name = "InsufficientScopeError";
  }
}

async function apiGet<Response>(
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<Response> {
  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) {
    throw new TokenExpiredError();
  }
  if (!response.ok) {
    const body = await response.text();
    if (
      response.status === 403 &&
      (body.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
        body.includes("insufficientPermissions"))
    ) {
      throw new InsufficientScopeError();
    }
    throw new Error(`YouTube API ${path} failed: ${response.status} ${body}`);
  }
  return response.json() as Promise<Response>;
}

interface SubscriptionListResponse {
  items: Array<{
    snippet: {
      title: string;
      resourceId: { channelId: string };
      thumbnails: { default?: { url: string }; medium?: { url: string } };
    };
  }>;
  nextPageToken?: string;
}

export async function fetchSubscriptions(
  token: string,
): Promise<Subscription[]> {
  const subscriptions: Subscription[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, string> = {
      part: "snippet",
      mine: "true",
      maxResults: "50",
      order: "alphabetical",
    };
    if (pageToken) {
      params.pageToken = pageToken;
    }
    const data = await apiGet<SubscriptionListResponse>(
      "/subscriptions",
      params,
      token,
    );
    for (const item of data.items) {
      subscriptions.push({
        channelId: item.snippet.resourceId.channelId,
        title: decodeHtmlEntities(item.snippet.title),
        thumbnail:
          item.snippet.thumbnails.medium?.url ??
          item.snippet.thumbnails.default?.url ??
          "",
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return subscriptions;
}

interface PlaylistItemsResponse {
  items: Array<{
    snippet: {
      title: string;
      description: string;
      publishedAt: string;
      videoOwnerChannelId?: string;
      videoOwnerChannelTitle?: string;
      thumbnails: {
        default?: { url: string };
        medium?: { url: string };
        high?: { url: string };
      };
    };
    contentDetails: { videoId: string; videoPublishedAt?: string };
  }>;
  nextPageToken?: string;
}

// A channel's uploads playlist ID is its channel ID with the "UC" prefix swapped
// for "UU", which lets us list uploads without spending a channels.list call.
export function uploadsPlaylistId(channelId: string): string {
  return `UU${channelId.slice(2)}`;
}

const HIDDEN_TITLES = new Set(["Private video", "Deleted video"]);

interface VideoListResponse {
  items: Array<{
    id: string;
    snippet: { liveBroadcastContent: "none" | "live" | "upcoming" };
    contentDetails: { duration: string };
    // Present only if the video was ever a live stream or premiere.
    liveStreamingDetails?: { actualEndTime?: string };
  }>;
}

export interface VideoDetails {
  durationSeconds: number;
  liveStatus: LiveStatus;
}

// Classify a video as live/upcoming/vod/normal. A finished broadcast (a stream
// replay or aired premiere) reports liveBroadcastContent "none" but carries
// liveStreamingDetails with an actualEndTime; a plain upload has neither.
function classifyLiveStatus(
  item: VideoListResponse["items"][number],
): LiveStatus {
  if (item.snippet.liveBroadcastContent === "live") {
    return "live";
  }
  if (item.snippet.liveBroadcastContent === "upcoming") {
    return "upcoming";
  }
  return item.liveStreamingDetails?.actualEndTime ? "vod" : "normal";
}

// Parse an ISO 8601 duration (e.g. "PT1H2M3S", "P1DT4M") to seconds. Live and
// upcoming videos report "P0D" (no time part), which yields 0.
export function parseIsoDuration(iso: string): number {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) {
    return 0;
  }
  const [days, hours, minutes, seconds] = match
    .slice(1)
    .map((part) => Number(part ?? 0));
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

// playlistItems doesn't expose duration or broadcast kind, so fetch those from
// videos.list separately (50 ids per call, flat 1 unit regardless of parts) and
// key by video id.
export async function fetchVideoDetails(
  videoIds: string[],
  token: string,
): Promise<Map<string, VideoDetails>> {
  const details = new Map<string, VideoDetails>();
  for (let start = 0; start < videoIds.length; start += 50) {
    const batch = videoIds.slice(start, start + 50);
    const data = await apiGet<VideoListResponse>(
      "/videos",
      {
        part: "snippet,contentDetails,liveStreamingDetails",
        id: batch.join(","),
      },
      token,
    );
    for (const item of data.items) {
      details.set(item.id, {
        durationSeconds: parseIsoDuration(item.contentDetails.duration),
        liveStatus: classifyLiveStatus(item),
      });
    }
  }
  return details;
}

// The playable video ids of a playlist, in playlist order — used to inline a
// playlist into the "Play all" queue. Pages through (50/call) up to `max`, which
// also caps it to the IFrame player's queue limit. Private/deleted entries are
// dropped so the queue doesn't stall on an unplayable id.
export async function fetchPlaylistVideoIds(
  playlistId: string,
  token: string,
  max = 200,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, string> = {
      part: "snippet,contentDetails",
      playlistId,
      maxResults: "50",
    };
    if (pageToken) {
      params.pageToken = pageToken;
    }
    const data = await apiGet<PlaylistItemsResponse>(
      "/playlistItems",
      params,
      token,
    );
    for (const item of data.items) {
      if (!HIDDEN_TITLES.has(item.snippet.title)) {
        ids.push(item.contentDetails.videoId);
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

export async function fetchUploads(
  channelId: string,
  channelTitle: string,
  token: string,
  maxResults = 15,
): Promise<Video[]> {
  const data = await apiGet<PlaylistItemsResponse>(
    "/playlistItems",
    {
      part: "snippet,contentDetails",
      playlistId: uploadsPlaylistId(channelId),
      maxResults: String(maxResults),
    },
    token,
  );
  const videos = data.items
    .filter((item) => !HIDDEN_TITLES.has(item.snippet.title))
    .map((item) => ({
      kind: "video" as const,
      videoId: item.contentDetails.videoId,
      channelId: item.snippet.videoOwnerChannelId ?? channelId,
      channelTitle: decodeHtmlEntities(
        item.snippet.videoOwnerChannelTitle ?? channelTitle,
      ),
      title: decodeHtmlEntities(item.snippet.title),
      description: item.snippet.description,
      publishedAt:
        item.contentDetails.videoPublishedAt ?? item.snippet.publishedAt,
      thumbnail:
        item.snippet.thumbnails.medium?.url ??
        item.snippet.thumbnails.default?.url ??
        "",
    }));

  const details = await fetchVideoDetails(
    videos.map((video) => video.videoId),
    token,
  );
  return videos.map((video) => {
    const detail = details.get(video.videoId);
    return {
      ...video,
      durationSeconds: detail?.durationSeconds ?? 0,
      liveStatus: detail?.liveStatus ?? "normal",
    };
  });
}

interface PlaylistListResponse {
  items: Array<{
    id: string;
    snippet: {
      title: string;
      description: string;
      publishedAt: string;
      channelId?: string;
      channelTitle?: string;
      thumbnails: {
        default?: { url: string };
        medium?: { url: string };
        high?: { url: string };
      };
    };
    contentDetails: { itemCount: number };
  }>;
  nextPageToken?: string;
}

// A channel's public, self-made playlists. playlists.list has no order param and
// only a creation timestamp, so we sort by that (newest first) ourselves — right
// for episode-per-playlist channels, the intended use. One page (50) keeps it
// quota-neutral with the uploads path; that's ~a year of weekly episodes.
export async function fetchPlaylists(
  channelId: string,
  channelTitle: string,
  token: string,
  maxResults = 50,
): Promise<Playlist[]> {
  const data = await apiGet<PlaylistListResponse>(
    "/playlists",
    {
      part: "snippet,contentDetails",
      channelId,
      maxResults: String(maxResults),
    },
    token,
  );
  return data.items
    .map((item) => ({
      kind: "playlist" as const,
      playlistId: item.id,
      channelId: item.snippet.channelId ?? channelId,
      channelTitle: decodeHtmlEntities(
        item.snippet.channelTitle ?? channelTitle,
      ),
      title: decodeHtmlEntities(item.snippet.title),
      description: item.snippet.description,
      publishedAt: item.snippet.publishedAt,
      thumbnail:
        item.snippet.thumbnails.medium?.url ??
        item.snippet.thumbnails.default?.url ??
        "",
      itemCount: item.contentDetails.itemCount,
    }))
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
}
