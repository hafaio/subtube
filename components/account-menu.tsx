import type { User } from "firebase/auth";
import Image from "next/image";
import { type ReactElement, useEffect, useRef, useState } from "react";

/**
 * The signed-in profile picture; clicking opens a small menu with the
 * less-prominent account actions (disconnect YouTube, sign out).
 */
export default function AccountMenu({
  user,
  ready,
  onDisconnect,
  onSignOut,
}: {
  user: User;
  ready: boolean;
  onDisconnect: () => void;
  onSignOut: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent): void => {
      if (
        container.current &&
        !container.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const name = user.displayName ?? user.email ?? "Account";
  return (
    <div className="relative" ref={container}>
      <button
        type="button"
        onClick={() => setOpen((shown) => !shown)}
        title={name}
        aria-label="Account"
        className="flex items-center rounded-full ring-slate-300 hover:ring-2 dark:ring-slate-600"
      >
        {user.photoURL ? (
          <Image
            src={user.photoURL}
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 rounded-full"
          />
        ) : (
          <span className="grid h-7 w-7 place-items-center rounded-full bg-slate-300 text-slate-700 text-xs dark:bg-slate-600 dark:text-slate-200">
            {name.charAt(0).toUpperCase()}
          </span>
        )}
      </button>
      {open ? (
        <div className="absolute right-0 z-30 mt-2 w-52 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-800">
          <div className="truncate border-slate-200 border-b px-3 py-2 text-slate-500 text-xs dark:border-slate-700 dark:text-slate-400">
            {name}
          </div>
          {ready ? (
            <button
              type="button"
              className="block w-full px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-700"
              onClick={() => {
                setOpen(false);
                onDisconnect();
              }}
            >
              Disconnect YouTube
            </button>
          ) : null}
          <button
            type="button"
            className="block w-full px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-700"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
