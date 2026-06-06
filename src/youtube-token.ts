import {
  backendDisconnect,
  backendRefresh,
  runConnectFlow,
  type TokenResult,
} from "./youtube-auth";

// Refresh a little before expiry so in-flight calls never 401.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let accessToken: string | null = null;
let expiresAt = 0;
let refreshInFlight: Promise<string> | null = null;

export function setToken(token: string, expiresInSeconds: number): void {
  accessToken = token;
  expiresAt = Date.now() + expiresInSeconds * 1000;
}

export function clearToken(): void {
  accessToken = null;
  expiresAt = 0;
}

function tokenIsFresh(): boolean {
  return accessToken !== null && Date.now() < expiresAt - REFRESH_MARGIN_MS;
}

export function hasToken(): boolean {
  return tokenIsFresh();
}

function apply(result: TokenResult): string {
  setToken(result.accessToken, result.expiresIn);
  return result.accessToken;
}

// Mint a fresh access token from the server-held refresh token. Rejects if the
// user has never connected YouTube (or the refresh token was revoked), in which
// case the caller should prompt an interactive connect.
export function silentRefresh(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = backendRefresh()
      .then(apply)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

// Run the interactive connect flow (popup); must be called from a user gesture.
export async function connectYouTube(): Promise<void> {
  apply(await runConnectFlow());
}

// Revoke the grant server-side and drop the in-memory token.
export async function disconnectYouTube(): Promise<void> {
  clearToken();
  await backendDisconnect();
}

export async function getValidToken(): Promise<string> {
  if (tokenIsFresh() && accessToken) {
    return accessToken;
  }
  return silentRefresh();
}
