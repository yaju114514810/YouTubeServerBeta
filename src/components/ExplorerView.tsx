import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react';
import type { PersonalizedFeedResponse, SearchVideoItem } from '../types/invidious';
import { probeApi, preloadNextVideos } from '../lib/api';
import { useAppSettings } from '../lib/appSettings';
import { translateTexts } from '../lib/translator';
import { clearWatchHistory, getWatchHistory } from '../lib/watchHistory';
import { VideoCard } from './VideoCard';

interface ExplorerViewProps {
  onSelectVideo: (videoId: string) => void;
  onSelectChannel: (channelId: string) => void;
}

const CATEGORIES = [
  { id: 'Recommended', label: 'おすすめ (あなた向け)' },
  { id: '4K', label: '4K HDR' },
  { id: 'Default', label: '急上昇' },
  { id: 'Music', label: '音楽 4K' },
  { id: 'Gaming', label: 'ゲーム 60fps' },
  { id: 'Tech', label: 'テック・OLED' },
] as const;

const REGIONS = [
  { id: 'JP', label: '地域: 日本 (JP)' },
  { id: 'US', label: '地域: 米国 (US)' },
  { id: 'GB', label: '地域: 英国 (GB)' },
  { id: 'DE', label: '地域: ドイツ (DE)' },
] as const;

const SORT_OPTIONS = [
  { id: 'relevance', label: '並び替え: 関連度' },
  { id: 'view_count', label: '並び替え: 再生回数' },
  { id: 'upload_date', label: '並び替え: 投稿日時' },
  { id: 'rating', label: '並び替え: 高評価' },
] as const;

export function ExplorerView({ onSelectVideo, onSelectChannel }: ExplorerViewProps) {
  const [query, setQuery] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [category, setCategory] = useState<string>(() =>
    getWatchHistory().length > 0 ? 'Recommended' : '4K',
  );
  const [region, setRegion] = useState<string>('JP');
  const [sortBy, setSortBy] = useState<string>('relevance');
  const [settings] = useAppSettings();
  const [videos, setVideos] = useState<SearchVideoItem[]>([]);
  const [translatedTitles, setTranslatedTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestionIdx, setActiveSuggestionIdx] = useState(-1);
  const [algoMeta, setAlgoMeta] = useState<{
    basisTopics: string[];
    basisAuthors: string[];
    summary: string;
    historyCount: number;
  } | null>(null);
  const [lastMeta, setLastMeta] = useState<{
    latencyMs: number;
    cacheStatus: string;
    upstreamNode: string;
  } | null>(null);

  const suggestTimer = useRef<number | null>(null);
  const isComposingRef = useRef(false);

  const loadFeed = async (
    searchTerm: string,
    cat: string,
    reg: string,
    sort: string,
    refresh = false,
  ) => {
    setLoading(true);
    setError(null);
    try {
      if (!searchTerm.trim() && cat === 'Recommended') {
        const history = getWatchHistory().slice(0, 25);
        const res = await probeApi<PersonalizedFeedResponse>('/api/v1/recommendations/feed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history, region: reg }),
        });
        const feedItems = res.data.items || [];
        setVideos(feedItems);
        preloadNextVideos(feedItems.slice(0, 3).map((v) => v.videoId));
        setAlgoMeta({
          basisTopics: res.data.basisTopics || [],
          basisAuthors: res.data.basisAuthors || [],
          summary: res.data.algorithmSummary || '',
          historyCount: history.length,
        });
        setLastMeta({
          latencyMs: res.latencyMs,
          cacheStatus: res.cacheStatus,
          upstreamNode: res.upstreamNode,
        });
        return;
      }

      setAlgoMeta(null);
      const endpoint = searchTerm.trim()
        ? `/api/v1/search?q=${encodeURIComponent(searchTerm.trim())}&type=video&sort_by=${encodeURIComponent(sort)}${refresh ? '&refresh=true' : ''}`
        : `/api/v1/trending?type=${encodeURIComponent(cat)}&region=${encodeURIComponent(reg)}${refresh ? '&refresh=true' : ''}`;

      const res = await probeApi<SearchVideoItem[]>(endpoint);
      setVideos(res.data);
      preloadNextVideos((res.data || []).slice(0, 3).map((v) => v.videoId));
      setLastMeta({
        latencyMs: res.latencyMs,
        cacheStatus: res.cacheStatus,
        upstreamNode: res.upstreamNode,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '動画一覧の取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFeed(activeSearch, category, region, sortBy);
  }, [activeSearch, category, region, sortBy]);

  useEffect(() => {
    if (!settings.autoTranslateEnabled || !settings.translateTitles || videos.length === 0) {
      setTranslatedTitles({});
      return;
    }
    let cancelled = false;
    translateTexts(
      videos.map((v) => v.title),
      settings.targetLang,
    ).then((translated) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      videos.forEach((v, idx) => {
        if (translated[idx] && translated[idx] !== v.title) {
          map[v.videoId] = translated[idx];
        }
      });
      setTranslatedTitles(map);
    });
    return () => {
      cancelled = true;
    };
  }, [videos, settings.autoTranslateEnabled, settings.translateTitles, settings.targetLang]);

  const fetchSuggestions = (rawTerm: string) => {
    if (suggestTimer.current) window.clearTimeout(suggestTimer.current);
    const trimmed = rawTerm.trim();
    if (!trimmed) {
      setSuggestions([]);
      setShowSuggestions(false);
      setActiveSuggestionIdx(-1);
      return;
    }
    suggestTimer.current = window.setTimeout(async () => {
      try {
        const res = await probeApi<{ suggestions: string[] }>(
          `/api/v1/search/suggestions?q=${encodeURIComponent(trimmed)}`,
        );
        const list = (res.data.suggestions || []).filter(Boolean);
        setSuggestions(list);
        setActiveSuggestionIdx(-1);
        setShowSuggestions(list.length > 0);
      } catch {
        setSuggestions([]);
      }
    }, 160);
  };

  const handleInputChange = (val: string) => {
    setQuery(val);
    if (!isComposingRef.current) {
      fetchSuggestions(val);
    }
  };

  const submitSearch = (term?: string) => {
    const finalTerm = (term ?? query).trim();
    setShowSuggestions(false);
    setActiveSuggestionIdx(-1);
    setQuery(finalTerm);
    setActiveSearch(finalTerm);
  };

  const clearSearch = () => {
    setQuery('');
    setActiveSearch('');
    setSuggestions([]);
    setShowSuggestions(false);
    setActiveSuggestionIdx(-1);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isComposingRef.current) return;
    if (!showSuggestions || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveSuggestionIdx((prev) => (prev + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveSuggestionIdx((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setActiveSuggestionIdx(-1);
    } else if (e.key === 'Enter' && activeSuggestionIdx >= 0 && suggestions[activeSuggestionIdx]) {
      e.preventDefault();
      submitSearch(suggestions[activeSuggestionIdx]);
    }
  };

  const handleResetHistory = () => {
    clearWatchHistory();
    loadFeed('', 'Recommended', region, sortBy, true);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 検索・フィルターバー */}
      <div className="flex flex-col gap-4 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitSearch();
            }}
            className="relative flex-1"
          >
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => handleInputChange(e.target.value)}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={(e) => {
                isComposingRef.current = false;
                fetchSuggestions(e.currentTarget.value);
              }}
              onKeyDown={handleInputKeyDown}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              onBlur={() => window.setTimeout(() => setShowSuggestions(false), 160)}
              placeholder="日本語・英語キーワード、アーティスト、4K動画を検索..."
              className="h-10 w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 pl-10 pr-24 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:border-blue-600 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label="検索をクリア"
                className="absolute right-18 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            <button
              type="submit"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
            >
              検索
            </button>

            {showSuggestions && suggestions.length > 0 && (
              <div
                role="listbox"
                aria-label="予測検索候補"
                className="absolute left-0 right-0 top-11 z-30 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 py-1 shadow-lg"
              >
                {suggestions.map((item, idx) => (
                  <button
                    key={`${item}-${idx}`}
                    type="button"
                    role="option"
                    aria-selected={idx === activeSuggestionIdx}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      submitSearch(item);
                    }}
                    className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm transition-colors ${
                      idx === activeSuggestionIdx
                        ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300'
                        : 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <Search className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                    <span className="truncate">{item}</span>
                  </button>
                ))}
              </div>
            )}
          </form>

          <div className="flex items-center gap-2 shrink-0">
            {activeSearch ? (
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                aria-label="並び替え"
                className="h-10 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-3 text-xs font-medium text-zinc-700 dark:text-zinc-200 focus:border-blue-600 focus:outline-none"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                aria-label="地域選択"
                className="h-10 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-3 text-xs font-medium text-zinc-700 dark:text-zinc-200 focus:border-blue-600 focus:outline-none"
              >
                {REGIONS.map((reg) => (
                  <option key={reg.id} value={reg.id}>
                    {reg.label}
                  </option>
                ))}
              </select>
            )}

            <button
              type="button"
              onClick={() => loadFeed(activeSearch, category, region, sortBy, true)}
              className="flex h-10 items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-3 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>更新</span>
            </button>
          </div>
        </div>

        {/* カテゴリタブ & 実測レスポンス速度 */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-zinc-100 dark:border-zinc-800/80">
          <div className="flex items-center gap-1 overflow-x-auto rounded-lg bg-zinc-100 dark:bg-zinc-950 p-1">
            {CATEGORIES.map((cat) => {
              const active = !activeSearch && category === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => {
                    setActiveSearch('');
                    setQuery('');
                    setCategory(cat.id);
                  }}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-white shadow-xs'
                      : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }`}
                >
                  {cat.label}
                </button>
              );
            })}
          </div>

          {lastMeta && (
            <div className="flex items-center gap-2 font-mono text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
              <span>{lastMeta.upstreamNode}</span>
              <span aria-hidden="true">·</span>
              <span className={lastMeta.cacheStatus === 'HIT' ? 'text-emerald-600 dark:text-emerald-400 font-medium' : ''}>
                {lastMeta.cacheStatus === 'HIT' ? 'キャッシュHIT' : lastMeta.cacheStatus === 'DYNAMIC' ? 'リアルタイム解析' : '新規取得 (MISS)'}
              </span>
              <span aria-hidden="true">·</span>
              <span>{lastMeta.latencyMs.toFixed(2)} ms</span>
            </div>
          )}
        </div>
      </div>

      {/* パーソナライズ推薦アルゴリズム説明バー */}
      {!activeSearch && category === 'Recommended' && algoMeta && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 dark:border-blue-900/50 bg-blue-50/70 dark:bg-blue-950/20 px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                視聴履歴パーソナライズ最適化
              </span>
              {algoMeta.basisTopics.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-blue-700 dark:text-blue-400">
                    注目トピック: {algoMeta.basisTopics.join(' · ')}
                  </span>
                </>
              )}
              {algoMeta.basisAuthors.length > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-zinc-600 dark:text-zinc-400">
                    好感度チャンネル: {algoMeta.basisAuthors.join(' · ')}
                  </span>
                </>
              )}
            </div>
            <p className="text-zinc-600 dark:text-zinc-400">{algoMeta.summary}</p>
          </div>

          {algoMeta.historyCount > 0 && (
            <button
              type="button"
              onClick={handleResetHistory}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>視聴履歴をリセット</span>
            </button>
          )}
        </div>
      )}

      {/* 検索見出し */}
      {activeSearch && (
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            「{activeSearch}」の検索結果
          </h2>
          <button
            type="button"
            onClick={clearSearch}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap shrink-0"
          >
            フィードに戻る
          </button>
        </div>
      )}

      {/* エラー状態 */}
      {error && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 p-5">
          <p className="text-sm font-medium text-red-700 dark:text-red-400">{error}</p>
          <button
            type="button"
            onClick={() => loadFeed(activeSearch, category, region, sortBy, true)}
            className="rounded-lg bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-700 transition-colors"
          >
            再試行
          </button>
        </div>
      )}

      {/* スケルトン読み込み */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden"
            >
              <div className="aspect-video w-full bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
              <div className="flex flex-col gap-2.5 p-3.5">
                <div className="h-4 w-5/6 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                <div className="h-3 w-1/2 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                <div className="h-3 w-2/3 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 空状態 */}
      {!loading && !error && videos.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 py-16 px-6 text-center">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            該当する動画が見つかりませんでした。
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            別のキーワードを試すか、おすすめ・4K HDR フィードへ戻ってください。
          </p>
          <button
            type="button"
            onClick={clearSearch}
            className="mt-1 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 transition-colors"
          >
            フィードをリセット
          </button>
        </div>
      )}

      {/* 動画グリッド */}
      {!loading && !error && videos.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {videos.map((v, idx) => (
            <VideoCard
              key={`${v.videoId}-${idx}`}
              video={v}
              displayTitle={translatedTitles[v.videoId]}
              onSelectVideo={onSelectVideo}
              onSelectChannel={onSelectChannel}
            />
          ))}
        </div>
      )}
    </div>
  );
}
