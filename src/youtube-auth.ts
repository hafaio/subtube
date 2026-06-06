import { getFunctions, httpsCallable } from "firebase/functions";
import { oauthClientId } from "./config";
import { firebaseApp } from "./firebase-app";

const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const CALLBACK_SOURCE = "subtube-oauth";

export interface TokenResult {
  accessToken: string;
  expiresIn: number;
}

interface CallbackMessage {
  source?: string;
  code?: string;
  state?: string;
  error?: string;
}

function callable<Request, Response>(name: string) {
  return httpsCallable<Request, Response>(getFunctions(firebaseApp()), name);
}

// Mint a fresh access token from the server-held refresh token. No UI: this is
// what lets a reload restore YouTube access without a popup.
export async function backendRefresh(): Promise<TokenResult> {
  const { data } = await callable<unknown, TokenResult>(
    "refreshYouTubeToken",
  )();
  return data;
}

// Revoke the grant with Google and forget the server-held refresh token.
export async function backendDisconnect(): Promise<void> {
  await callable<unknown, { ok: true }>("disconnectYouTube")();
}

async function backendExchange(
  code: string,
  redirectUri: string,
): Promise<TokenResult> {
  const { data } = await callable<
    { code: string; redirectUri: string },
    TokenResult
  >("exchangeYouTubeCode")({ code, redirectUri });
  return data;
}

// Run the interactive Authorization Code flow in a popup, then exchange the code
// server-side. Must be called from a user gesture so the popup isn't blocked.
export async function runConnectFlow(): Promise<TokenResult> {
  // Redirect back to the app's own URL. Using the live pathname (minus any
  // trailing slash) bakes in whatever basePath the deploy uses — origin at the
  // domain root (e.g. localhost), origin + "/subtube" on a GitHub Pages project
  // site — so it adapts without per-environment config. (Register this exact URI
  // under the OAuth client's Authorized redirect URIs.)
  const redirectUri =
    window.location.origin + window.location.pathname.replace(/\/$/, "");
  const state = crypto.randomUUID();
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: oauthClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  }).toString();

  const popup = window.open(
    url.toString(),
    "subtube-youtube",
    "width=500,height=640",
  );
  if (!popup) {
    throw new Error(
      "Popup blocked — allow popups for this site and try again.",
    );
  }

  const code = await new Promise<string>((resolve, reject) => {
    const settle = (fn: () => void) => {
      window.clearInterval(poll);
      window.removeEventListener("message", onMessage);
      fn();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }
      const message = event.data as CallbackMessage;
      if (message?.source !== CALLBACK_SOURCE) {
        return;
      }
      popup.close();
      if (message.error) {
        settle(() => reject(new Error(message.error)));
      } else if (message.state !== state) {
        settle(() =>
          reject(new Error("Authorization state mismatch; aborted.")),
        );
      } else if (message.code) {
        const grantedCode = message.code;
        settle(() => resolve(grantedCode));
      } else {
        settle(() => reject(new Error("No authorization code returned.")));
      }
    };
    const poll = window.setInterval(() => {
      if (popup.closed) {
        settle(() => reject(new Error("Authorization was cancelled.")));
      }
    }, 500);
    window.addEventListener("message", onMessage);
  });

  return backendExchange(code, redirectUri);
}

// True when this document is the popup landing on the redirect URI with a code.
export function isOAuthCallback(): boolean {
  if (typeof window === "undefined" || !window.opener) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  return params.has("code") || params.has("error");
}

// Hand the code (or error) back to the opener and close the popup.
export function completeOAuthCallback(): void {
  const params = new URLSearchParams(window.location.search);
  const message: CallbackMessage = {
    source: CALLBACK_SOURCE,
    code: params.get("code") ?? undefined,
    state: params.get("state") ?? undefined,
    error: params.get("error") ?? undefined,
  };
  window.opener?.postMessage(message, window.location.origin);
  window.close();
}
