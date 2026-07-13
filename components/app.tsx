"use client";

import type { User } from "firebase/auth";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { signIn, watchAuth } from "../src/firebase";
import { completeOAuthCallback, isOAuthCallback } from "../src/youtube-auth";
import {
  connectYouTube,
  disconnectYouTube,
  hasToken,
  silentRefresh,
} from "../src/youtube-token";
import Feed from "./feed";
import Login from "./login";

export default function App(): ReactElement {
  // When this document is the OAuth popup (loaded at the redirect URI with a
  // code), hand the code back to the opener and close — render nothing else.
  const [isCallback] = useState(
    () => typeof window !== "undefined" && isOAuthCallback(),
  );
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isCallback) {
      completeOAuthCallback();
    }
  }, [isCallback]);

  useEffect(() => {
    if (isCallback) {
      return;
    }
    return watchAuth(setUser);
  }, [isCallback]);

  // For a returning user, restore YouTube access via the server-held refresh
  // token — no popup. Fails (and prompts connect) if they never connected.
  useEffect(() => {
    if (isCallback || !user) {
      return;
    }
    if (hasToken()) {
      setReady(true);
      return;
    }
    let cancelled = false;
    setChecking(true);
    silentRefresh()
      .then(() => {
        if (!cancelled) {
          setReady(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReady(false);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setChecking(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user, isCallback]);

  const signInIdentity = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      await signIn();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      await connectYouTube();
      setReady(true);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setConnecting(false);
    }
  }, []);

  // drop to disconnected only after the server revokes; on failure this rejects (Feed surfaces it) and stays connected
  const disconnect = useCallback(async () => {
    await disconnectYouTube();
    setReady(false);
  }, []);

  if (isCallback) {
    return (
      <div className="grid h-screen place-items-center text-slate-500 dark:text-slate-400">
        Connecting…
      </div>
    );
  }
  if (user === undefined) {
    return (
      <div className="grid h-screen place-items-center text-slate-500 dark:text-slate-400">
        Loading…
      </div>
    );
  }
  if (user === null) {
    return (
      <Login onConnect={signInIdentity} connecting={connecting} error={error} />
    );
  }
  return (
    // keyed so switching accounts remounts rather than showing the previous
    // user's cached feed while the new one loads
    <Feed
      key={user.uid}
      user={user}
      ready={ready}
      checking={checking}
      connecting={connecting}
      onReconnect={connect}
      onDisconnect={disconnect}
      onTokenLost={() => setReady(false)}
    />
  );
}
