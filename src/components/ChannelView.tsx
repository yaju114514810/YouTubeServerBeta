import { useEffect, useState } from 'react';
import { ArrowLeft, Code2 } from 'lucide-react';
import type { ChannelResponse } from '../types/invidious';
import { probeApi } from '../lib/api';
import { useAppSettings } from '../lib/appSettings';
import { translateTexts } from '../lib/translator';
import { VideoCard } from './VideoCard';

interface ChannelViewProps {
  channelId: string;
  onSelectVideo: (videoId: string) => void;
  onSelectChannel: (channelId: string) => void;
  onInspectInApi: (endpoint: string) => void;
  onBack: () => void;
}

export function ChannelView({
  channelId,
  onSelectVideo,
  onSelectChannel,
  onInspectInApi,
  onBack,
}: ChannelViewProps) {
  const [settings] = useAppSettings();
  const [channel, setChannel] = useState<ChannelResponse | null>(null);
  const [translatedDesc, setTranslatedDesc] = useState<string | null>(null);
  const [translatedTitles, setTranslatedTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    probeApi<ChannelResponse>(`/api/v1/channels/${encodeURIComponent(channelId)}`)
      .then((res) => {
        if (cancelled) return;
        setChannel(res.data);
        setLatencyMs(res.latencyMs);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'チャンネル情報の取得に失敗しました');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  useEffect(() => {
    if (!channel || !settings.autoTranslateEnabled) {
      setTranslatedDesc(null);
      setTranslatedTitles({});
      return;
    }
    let cancelled = false;
    if (settings.translateDescriptions && channel.description) {
      translateTexts([channel.description], settings.targetLang).then(([tr]) => {
        if (!cancelled && tr && tr !== channel.description) setTranslatedDesc(tr);
      });
    } else {
      setTranslatedDesc(null);
    }
    if (settings.translateTitles && channel.latestVideos.length > 0) {
      translateTexts(
        channel.latestVideos.map((v) => v.title),
        settings.targetLang,
      ).then((trs) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        channel.latestVideos.forEach((v, idx) => {
          if (trs[idx] && trs[idx] !== v.title) map[v.videoId] = trs[idx];
        });
        setTranslatedTitles(map);
      });
    } else {
      setTranslatedTitles({});
    }
    return () => {
      cancelled = true;
    };
  }, [
    channel,
    settings.autoTranslateEnabled,
    settings.translateDescriptions,
    settings.translateTitles,
    settings.targetLang,
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>戻る</span>
        </button>

        <button
          type="button"
          onClick={() => onInspectInApi(`/api/v1/channels/${channelId}`)}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
        >
          <Code2 className="h-3.5 w-3.5" />
          <span>チャンネル JSON を確認</span>
        </button>
      </div>

      {loading && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
          <div className="h-24 w-full rounded-lg bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 p-5 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {!loading && channel && (
        <>
          <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            {channel.authorBanners?.[0]?.url && (
              <div className="h-36 sm:h-48 w-full bg-zinc-200 dark:bg-zinc-950 overflow-hidden">
                <img
                  src={channel.authorBanners[0].url}
                  alt={`${channel.author} バナー`}
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5">
              <div className="flex items-center gap-4">
                {channel.authorThumbnails?.[0]?.url ? (
                  <img
                    src={channel.authorThumbnails[0].url}
                    alt={channel.author}
                    referrerPolicy="no-referrer"
                    className="h-16 w-16 rounded-full object-cover bg-zinc-200 dark:bg-zinc-800 shrink-0"
                  />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-800 text-xl font-bold shrink-0">
                    {channel.author.charAt(0).toUpperCase()}
                  </div>
                )}

                <div className="flex flex-col gap-1">
                  <h2 className="text-xl font-bold text-zinc-950 dark:text-white">
                    {channel.author}
                  </h2>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                    <span className="font-mono">{channel.authorId}</span>
                    {channel.subCountText && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{channel.subCountText}</span>
                      </>
                    )}
                    {latencyMs !== null && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">{latencyMs.toFixed(2)} ms</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {channel.description && (
              <div className="border-t border-zinc-100 dark:border-zinc-800 px-5 py-4">
                <p className="text-sm text-zinc-600 dark:text-zinc-300 line-clamp-3">
                  {translatedDesc || channel.description}
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {channel.latestVideos.map((v) => (
              <VideoCard
                key={v.videoId}
                video={v}
                displayTitle={translatedTitles[v.videoId]}
                onSelectVideo={onSelectVideo}
                onSelectChannel={onSelectChannel}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
