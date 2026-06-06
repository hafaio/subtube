import Image from "next/image";
import type { ReactElement } from "react";
import { MdPlaylistPlay, MdVisibility, MdVisibilityOff } from "react-icons/md";
import type { Playlist } from "../src/types";

export default function PlaylistCard({
  playlist,
  watched,
  onOpen,
  onOpenChannel,
  onToggleWatched,
}: {
  playlist: Playlist;
  watched: boolean;
  onOpen: () => void;
  onOpenChannel: () => void;
  onToggleWatched: () => void;
}): ReactElement {
  const published = new Date(playlist.publishedAt);
  return (
    <div
      className={`flex flex-col overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800 ${watched ? "opacity-40" : ""}`}
    >
      <button
        type="button"
        className="relative aspect-video w-full bg-slate-200 dark:bg-slate-700"
        onClick={onOpen}
        aria-label={`Play ${playlist.title}`}
      >
        {playlist.thumbnail ? (
          <Image
            src={playlist.thumbnail}
            alt=""
            fill
            sizes="(max-width: 640px) 100vw, 280px"
            className="object-cover"
          />
        ) : null}
        {watched ? (
          <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-white text-xs">
            watched
          </span>
        ) : null}
        <span className="absolute right-1 bottom-1 flex items-center gap-1 rounded bg-black/70 px-1 py-0.5 text-white text-xs">
          <MdPlaylistPlay className="text-sm" />
          {playlist.itemCount}
        </span>
      </button>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="line-clamp-2 text-sm font-medium" title={playlist.title}>
          {playlist.title}
        </p>
        <button
          type="button"
          onClick={onOpenChannel}
          title={`View ${playlist.channelTitle}`}
          className="max-w-full self-start truncate text-left text-slate-500 text-xs hover:underline dark:text-slate-400"
        >
          {playlist.channelTitle}
        </button>
        <div className="mt-auto flex items-center justify-between pt-2 text-slate-500 text-xs">
          <span>{published.toLocaleDateString()}</span>
          <button
            type="button"
            className="flex items-center text-base hover:text-slate-900 dark:hover:text-slate-200"
            onClick={onToggleWatched}
            title={watched ? "Mark as unwatched" : "Mark as watched"}
            aria-label={watched ? "Mark as unwatched" : "Mark as watched"}
          >
            {watched ? <MdVisibility /> : <MdVisibilityOff />}
          </button>
        </div>
      </div>
    </div>
  );
}
