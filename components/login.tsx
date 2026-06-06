"use client";

import type { ReactElement } from "react";
import { FaGoogle } from "react-icons/fa";
import { MdSmartDisplay } from "react-icons/md";
import ThemeToggle from "./theme-toggle";

export default function Login({
  onConnect,
  connecting,
  error,
}: {
  onConnect: () => void;
  connecting: boolean;
  error: string | null;
}): ReactElement {
  return (
    <div className="grid h-screen place-items-center bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <div className="absolute top-3 right-3 text-sm">
        <ThemeToggle />
      </div>
      <div className="flex flex-col items-center gap-4 px-6 text-center">
        <h1 className="flex items-center gap-2 font-bold text-4xl">
          <MdSmartDisplay className="text-red-600" />
          subtube
        </h1>
        <p className="max-w-sm text-slate-500 dark:text-slate-400">
          Your subscriptions, your filters, no algorithm.
        </p>
        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          className="flex items-center gap-2 rounded-full bg-red-600 px-6 py-3 font-medium text-white transition hover:bg-red-500 disabled:opacity-60"
        >
          <FaGoogle className="text-lg" />
          {connecting ? "Signing in…" : "Sign in with Google"}
        </button>
        {error ? (
          <p className="text-red-600 text-sm dark:text-red-400">{error}</p>
        ) : null}
      </div>
    </div>
  );
}
