import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { type CallableRequest, HttpsError, onCall } from "firebase-functions/v2/https";
import pMap from "p-map";

initializeApp();

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface TokenResult {
  accessToken: string;
  expiresIn: number;
}

function clientId(): string {
  const value = process.env.YT_OAUTH_CLIENT_ID;
  if (!value) {
    throw new HttpsError("failed-precondition", "Server missing YT_OAUTH_CLIENT_ID");
  }
  return value;
}

function clientSecret(): string {
  const value = process.env.YT_OAUTH_CLIENT_SECRET;
  if (!value) {
    throw new HttpsError("failed-precondition", "Server missing YT_OAUTH_CLIENT_SECRET");
  }
  return value;
}

// The refresh token is stored under a server-only path (Firestore rules deny all
// client access to users/{uid}/private/**); only the Admin SDK here can read it.
function refreshTokenDoc(uid: string) {
  return getFirestore().doc(`users/${uid}/private/youtube`);
}

function requireUid(request: CallableRequest): string {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in before connecting YouTube.");
  }
  return uid;
}

async function postToken(params: Record<string, string>): Promise<GoogleTokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return (await response.json()) as GoogleTokenResponse;
}

// Trade the one-time authorization code for tokens, persist the refresh token
// server-side, and return only the short-lived access token to the browser.
export const exchangeYouTubeCode = onCall<{ code?: string; redirectUri?: string }>(
  async (request): Promise<TokenResult> => {
    const uid = requireUid(request);
    const { code, redirectUri } = request.data;
    if (!code || !redirectUri) {
      throw new HttpsError("invalid-argument", "Missing code or redirectUri.");
    }
    const tokens = await postToken({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    if (!tokens.access_token) {
      throw new HttpsError(
        "permission-denied",
        tokens.error_description ?? tokens.error ?? "Authorization code exchange failed.",
      );
    }
    // A refresh token is only returned on first consent (or with prompt=consent).
    if (tokens.refresh_token) {
      await refreshTokenDoc(uid).set({
        refreshToken: tokens.refresh_token,
        updatedAt: Date.now(),
      });
    }
    return { accessToken: tokens.access_token, expiresIn: tokens.expires_in ?? 3600 };
  },
);

// Mint a fresh access token from the stored refresh token. This is what makes
// reloads seamless — no popup, the durable credential never leaves the server.
export const refreshYouTubeToken = onCall(async (request): Promise<TokenResult> => {
  const uid = requireUid(request);
  const snapshot = await refreshTokenDoc(uid).get();
  const refreshToken = snapshot.get("refreshToken") as string | undefined;
  if (!refreshToken) {
    throw new HttpsError("failed-precondition", "YouTube is not connected.");
  }
  const tokens = await postToken({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (!tokens.access_token) {
    // invalid_grant means the refresh token was revoked/expired — drop it so the
    // user is cleanly prompted to reconnect.
    if (tokens.error === "invalid_grant") {
      await refreshTokenDoc(uid).delete();
    }
    throw new HttpsError(
      "failed-precondition",
      tokens.error_description ?? "Could not refresh YouTube access.",
    );
  }
  return { accessToken: tokens.access_token, expiresIn: tokens.expires_in ?? 3600 };
});

const SHORTS_PROBE_BASE = "https://www.youtube.com/shorts/";
// A browser-ish UA: YouTube serves the redirect-vs-200 behaviour to clients, and
// can answer bare bots differently.
const SHORTS_PROBE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SHORTS_PROBE_TIMEOUT_MS = 5000;
const SHORTS_PROBE_CONCURRENCY = 12;
// Retries because an inconclusive answer (rate-limit, transient error) is worth
// re-attempting; a slow first load is fine.
const SHORTS_PROBE_RETRIES = 2;
const SHORTS_PROBE_RETRY_DELAY_MS = 300;
// The client pre-filters to sub-3-min candidates, so this bounds only a
// pathologically large batch.
const SHORTS_MAX_PROBES = 1024;

// Whether a video is a Short isn't user-specific, so cache it once globally as a
// bare { isShort } doc. Server-only: no client allow rule in firestore.rules,
// written only here.
function videoMetaDoc(videoId: string) {
  return getFirestore().doc(`videoMeta/${videoId}`);
}

// One probe: youtube.com/shorts/{id} serves 200 for a real Short and a 3xx
// redirect for a normal video. Server-side because the browser can't read the
// cross-origin status; `redirect: "manual"` so we see the redirect rather than
// follow it, and we never read the body. Returns true (200) / false (3xx), or
// null for anything else (4xx/5xx/network/timeout) — an inconclusive result we
// don't trust.
async function probeOnce(videoId: string): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHORTS_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${SHORTS_PROBE_BASE}${videoId}`, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": SHORTS_PROBE_UA,
        "accept-language": "en-US,en;q=0.9",
        // Pre-consent cookie so a datacenter IP isn't bounced to a consent page.
        cookie: "SOCS=CAI; CONSENT=YES+",
      },
      signal: controller.signal,
    });
    // cancel the unread body so undici frees the socket (a 200 is full HTML) instead of holding it until GC
    void response.body?.cancel();
    if (response.status === 200) {
      return true;
    }
    if (response.status >= 300 && response.status < 400) {
      return false;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Probe with a few attempts; returns null only if every attempt was
// inconclusive, in which case the caller leaves it uncached to retry later.
async function probeIsShort(videoId: string): Promise<boolean | null> {
  for (let attempt = 0; attempt <= SHORTS_PROBE_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, SHORTS_PROBE_RETRY_DELAY_MS),
      );
    }
    const verdict = await probeOnce(videoId);
    if (verdict !== null) {
      return verdict;
    }
  }
  return null;
}

// Classify the given video ids as Short or not, reading from the shared cache and
// probing only the misses (then caching them). Returns a map of id -> isShort;
// ids whose probe errors out are simply omitted (the client leaves them
// unlabelled rather than guessing).
export const classifyShorts = onCall<{ videoIds?: string[] }>(
  { timeoutSeconds: 300 },
  async (request): Promise<{ shorts: Record<string, boolean> }> => {
    requireUid(request);
    const ids = [...new Set(request.data.videoIds ?? [])].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    if (ids.length === 0) {
      return { shorts: {} };
    }

    const shorts = new Map<string, boolean>();
    const cached = await getFirestore().getAll(...ids.map(videoMetaDoc));
    const misses: string[] = [];
    cached.forEach((snapshot, index) => {
      const isShort = snapshot.get("isShort") as boolean | undefined;
      if (typeof isShort === "boolean") {
        shorts.set(ids[index], isShort);
      } else {
        misses.push(ids[index]);
      }
    });

    const toProbe = misses.slice(0, SHORTS_MAX_PROBES);
    await pMap(
      toProbe,
      async (id) => {
        try {
          const isShort = await probeIsShort(id);
          // null = inconclusive after retries: leave it uncached so a later load
          // re-probes it.
          if (isShort === null) {
            return;
          }
          shorts.set(id, isShort);
          await videoMetaDoc(id).set({ isShort });
        } catch {
          // Firestore write failed: leave it unknown, don't block the batch.
        }
      },
      { concurrency: SHORTS_PROBE_CONCURRENCY },
    );

    let found = 0;
    for (const isShort of shorts.values()) {
      if (isShort) {
        found++;
      }
    }
    console.log(
      `classifyShorts: ${ids.length} requested, ${ids.length - misses.length} cached, ` +
        `probed ${toProbe.length}, ${found} shorts`,
    );
    // serialize the Map to a plain object for the callable's JSON response.
    return { shorts: Object.fromEntries(shorts) };
  },
);

// Revoke the grant with Google and forget the stored refresh token.
export const disconnectYouTube = onCall(async (request): Promise<{ ok: true }> => {
  const uid = requireUid(request);
  const snapshot = await refreshTokenDoc(uid).get();
  const refreshToken = snapshot.get("refreshToken") as string | undefined;
  if (refreshToken) {
    await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(refreshToken)}`, {
      method: "POST",
    });
    await refreshTokenDoc(uid).delete();
  }
  return { ok: true };
});
