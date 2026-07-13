import Image from "next/image";
import type { ReactElement } from "react";
import { MdVisibility, MdVisibilityOff } from "react-icons/md";
import { formatDuration } from "../src/duration";
import type { Video } from "../src/types";

export default function VideoCard({
  video,
  watched,
  onOpen,
  onOpenChannel,
  onToggleWatched,
}: {
  video: Video;
  watched: boolean;
  onOpen: () => void;
  onOpenChannel: () => void;
  onToggleWatched: () => void;
}): ReactElement {
  const published = new Date(video.publishedAt);
  return (
    <div
      className={`flex flex-col overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800 ${watched ? "opacity-40" : ""}`}
    >
      <button
        type="button"
        className="relative aspect-video w-full bg-slate-200 dark:bg-slate-700"
        onClick={onOpen}
        title="Play"
        aria-label={`Play ${video.title}`}
      >
        {video.thumbnail ? (
          <Image
            src={video.thumbnail}
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
        {video.isShort ? (
          <span className="absolute top-1 left-1 rounded bg-black/70 px-1 py-0.5 text-white text-xs">
            Short
          </span>
        ) : null}
        {video.durationSeconds ? (
          <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 py-0.5 text-white text-xs">
            {formatDuration(video.durationSeconds)}
          </span>
        ) : null}
      </button>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="line-clamp-2 text-sm font-medium" title={video.title}>
          {video.title}
        </p>
        <button
          type="button"
          onClick={onOpenChannel}
          title={`View ${video.channelTitle}`}
          className="max-w-full self-start truncate text-left text-slate-500 text-xs hover:underline dark:text-slate-400"
        >
          {video.channelTitle}
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
