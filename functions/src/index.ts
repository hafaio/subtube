import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
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

/**
 * The refresh token is stored under a server-only path (Firestore rules deny all
 * client access to users/{uid}/private/**); only the Admin SDK here can read it.
 */
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

/**
 * Trade the one-time authorization code for tokens, persist the refresh token
 * server-side, and return only the short-lived access token to the browser.
 */
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

/**
 * Mint a fresh access token from the stored refresh token. This is what makes
 * reloads seamless — no popup, the durable credential never leaves the server.
 */
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
// re-attempting; a slow first classification is fine.
const SHORTS_PROBE_RETRIES = 2;
const SHORTS_PROBE_RETRY_DELAY_MS = 300;
/**
 * How long the drain waits for another unclassified video before deciding the
 * queue is empty and going home.
 */
const DRAIN_IDLE_MS = 5000;

/**
 * How long to wait for the very first snapshot, which has a cold start and the
 * listener handshake in front of it. Going home on the ordinary idle gap would
 * strand the document that fired the trigger, and nothing would re-deliver it.
 */
const DRAIN_FIRST_SNAPSHOT_MS = 30 * 1000;

/**
 * Stop taking new work with time to spare inside the function's timeout. Anything
 * left stays queued, and the next request's event drains it.
 */
const DRAIN_BUDGET_MS = 8 * 60 * 1000;

/**
 * How many times a drain re-probes a video whose write failed. The listener only
 * re-delivers a document that changed, and a failed write changes nothing, so a
 * failure has to be re-queued here or the document is stranded.
 */
const DRAIN_MAX_ATTEMPTS = 2;

/**
 * One probe: youtube.com/shorts/{id} serves 200 for a real Short and a 3xx
 * redirect for a normal video. Server-side because the browser can't read the
 * cross-origin status; `redirect: "manual"` so we see the redirect rather than
 * follow it, and we never read the body. Returns true (200) / false (3xx), or
 * null for anything else (4xx/5xx/network/timeout) — an inconclusive result we
 * don't trust.
 */
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

/**
 * Probe with a few attempts; returns null only if every attempt was
 * inconclusive, in which case the caller leaves it uncached to retry later.
 */
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

/** Every video asked about but not yet classified — the work queue. */
function unclassifiedVideos() {
  return getFirestore().collection("videoMeta").where("isShort", "==", null);
}

/**
 * Probe one video and record what came back, reporting whether the document was
 * settled. An inconclusive probe deletes it rather than cache a guess: nothing is
 * known about the video, and the next client to want it will ask again. A failed
 * write settles nothing and leaves it queued.
 */
async function classifyOne(videoId: string): Promise<boolean> {
  const document = getFirestore().doc(`videoMeta/${videoId}`);
  try {
    const isShort = await probeIsShort(videoId);
    if (isShort === null) {
      await document.delete();
    } else {
      await document.set({ isShort, classifiedAt: Date.now() });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Work the queue of unclassified videos until it has been quiet for DRAIN_IDLE_MS,
 * then resolve with how many were classified. Listener-driven, so a video
 * requested while this runs joins the same drain.
 */
function drainUnclassified(): Promise<number> {
  return new Promise((resolve, reject) => {
    const queue: string[] = [];
    const attempts = new Map<string, number>();
    const deadline = Date.now() + DRAIN_BUDGET_MS;
    let classified = 0;
    let working = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;

    const finish = () => {
      clearTimeout(idleTimer);
      unsubscribe?.();
      resolve(classified);
    };
    // a straggler request may still be in flight, so an empty queue only ends the
    // drain once it stays empty
    const goHomeWhenQuiet = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, DRAIN_IDLE_MS);
    };

    const work = async () => {
      if (working) {
        return;
      }
      working = true;
      clearTimeout(idleTimer);
      try {
        while (queue.length > 0 && Date.now() < deadline) {
          const batch = queue.splice(0, SHORTS_PROBE_CONCURRENCY);
          const settled = await pMap(batch, classifyOne, {
            concurrency: SHORTS_PROBE_CONCURRENCY,
          });
          batch.forEach((videoId, index) => {
            const tries = attempts.get(videoId) ?? 1;
            if (settled[index]) {
              classified++;
            } else if (tries < DRAIN_MAX_ATTEMPTS) {
              attempts.set(videoId, tries + 1);
              queue.push(videoId);
            }
          });
        }
      } finally {
        working = false;
        if (Date.now() >= deadline) {
          finish();
        } else {
          goHomeWhenQuiet();
        }
      }
    };

    unsubscribe = unclassifiedVideos().onSnapshot((snapshot) => {
      for (const document of snapshot.docs) {
        // a document keeps matching the query until its verdict is written, so it
        // re-arrives in snapshots while being probed
        if (!attempts.has(document.id)) {
          attempts.set(document.id, 1);
          queue.push(document.id);
        }
      }
      void work();
    }, reject);
    idleTimer = setTimeout(finish, DRAIN_FIRST_SNAPSHOT_MS);
  });
}

/**
 * Fill in Shorts verdicts. A client asks about a video by creating
 * videoMeta/{id} with a null verdict, which fires this — and it then drains every
 * unclassified video, not only the one that woke it.
 *
 * `maxInstances: 1` serializes the events, so the first drains the queue and the
 * rest find it empty: no two instances probe the same video, so no lock is needed.
 * A drain starts from the whole query rather than the document that woke it, so
 * one stranded by a dropped event is swept up by the next, and no retry policy is
 * needed either.
 */
export const classifyShort = onDocumentCreated(
  {
    document: "videoMeta/{videoId}",
    maxInstances: 1,
    timeoutSeconds: 540,
  },
  async () => {
    const classified = await drainUnclassified();
    if (classified > 0) {
      console.log(`classifyShort: classified ${classified} video(s)`);
    }
  },
);

/**
 * Revoke the grant with Google and forget the stored refresh token.
 */
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
