import { useState } from 'react';
import { Play } from 'lucide-react';
import type { SearchVideoItem } from '../types/invidious';
import { formatDuration, prefetchVideo } from '../lib/api';

interface VideoCardProps {
  video: SearchVideoItem;
  displayTitle?: string;
  onSelectVideo: (videoId: string) => void;
  onSelectChannel: (channelId: string) => void;
}

export function VideoCard({ video, displayTitle, onSelectVideo, onSelectChannel }: VideoCardProps) {
  const [imgError, setImgError] = useState(false);
  const thumbUrl = video.videoThumbnails?.[0]?.url || `/api/v1/thumbnail/${video.videoId}/maxresdefault`;
  const effectiveTitle = displayTitle && displayTitle !== video.title ? displayTitle : video.title;
  const isTranslated = Boolean(displayTitle && displayTitle !== video.title);

  return (
    <article
      className="group flex flex-col rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 overflow-hidden transition-colors duration-150 hover:border-zinc-300 dark:hover:border-zinc-700"
      onMouseEnter={() => prefetchVideo(video.videoId)}
    >
      <button
        type="button"
        onClick={() => onSelectVideo(video.videoId)}
        className="relative aspect-video w-full bg-zinc-100 dark:bg-zinc-950 overflow-hidden text-left focus-visible:outline-2 focus-visible:outline-blue-600"
        aria-label={`${effectiveTitle} を再生`}
      >
        {!imgError ? (
          <img
            src={thumbUrl}
            alt={effectiveTitle}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-zinc-200 to-zinc-300 dark:from-zinc-800 dark:to-zinc-900 p-4 text-center">
            <Play className="h-7 w-7 text-zinc-500 dark:text-zinc-400" />
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400 line-clamp-2">
              {effectiveTitle}
            </span>
          </div>
        )}

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 transition-opacity duration-150 group-hover:opacity-100" />

        <span className="absolute bottom-2 right-2 rounded bg-zinc-950/85 px-1.5 py-0.5 font-mono text-[11px] font-medium text-white tabular-nums">
          {video.liveNow ? 'ライブ' : formatDuration(video.lengthSeconds)}
        </span>
      </button>

      <div className="flex flex-1 flex-col justify-between gap-2 p-3.5">
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={() => onSelectVideo(video.videoId)}
            title={isTranslated ? `原文: ${video.title}` : video.title}
            className="text-left text-sm font-semibold leading-snug text-zinc-900 dark:text-zinc-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors line-clamp-2"
          >
            {effectiveTitle}
          </button>
          {isTranslated && (
            <span className="truncate text-[11px] text-zinc-400 dark:text-zinc-500">
              翻訳済 · {video.title}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {video.authorId ? (
            <button
              type="button"
              onClick={() => onSelectChannel(video.authorId)}
              className="w-fit max-w-full truncate font-medium text-zinc-700 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white transition-colors"
            >
              {video.author}
            </button>
          ) : (
            <span className="truncate font-medium text-zinc-700 dark:text-zinc-300">
              {video.author}
            </span>
          )}

          <div className="flex items-center gap-1.5 truncate tabular-nums">
            <span>{video.viewCountText || '0 回視聴'}</span>
            {video.is4k && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono font-medium text-blue-600 dark:text-blue-400">4K UHD</span>
              </>
            )}
            {video.publishedText && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{video.publishedText}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
