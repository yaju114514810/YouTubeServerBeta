import type { RecommendedVideo, WatchHistoryEntry } from '../types/invidious';

const STORAGE_KEY = 'kurostream_watch_history_v1';
const MAX_ENTRIES = 30;

const STOP_WORDS = new Set([
  'official',
  'video',
  'music',
  '4k',
  'hdr',
  '60fps',
  'full',
  'live',
  'mv',
  'pv',
  'shorts',
  'youtube',
  '公式',
  '動画',
  '高画質',
  '最新',
  '日本',
  'japan',
  'the',
  'and',
  'for',
  'with',
  'ver',
  'hd',
  'uhd',
]);

export function extractTopicTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[【】「」『』()[\]|・/\\!?！？,.:;"'#]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

export function getWatchHistory(): WatchHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is WatchHistoryEntry =>
        Boolean(item && typeof item.videoId === 'string' && typeof item.title === 'string'),
    );
  } catch {
    return [];
  }
}

export function recordWatch(video: {
  videoId: string;
  title: string;
  author: string;
  authorId?: string;
  keywords?: string[];
  description?: string;
}): WatchHistoryEntry[] {
  if (!video.videoId || !video.title) return getWatchHistory();
  const current = getWatchHistory();
  const existing = current.find((e) => e.videoId === video.videoId);
  const now = Date.now();

  const rawKeywords = [
    ...(video.keywords || []),
    ...extractTopicTokens(video.title),
  ];
  const dedupedKeywords = [...new Set(rawKeywords.map((k) => k.trim()).filter(Boolean))].slice(0, 14);

  const updatedEntry: WatchHistoryEntry = {
    videoId: video.videoId,
    title: video.title,
    author: video.author || existing?.author || '',
    authorId: video.authorId || existing?.authorId || '',
    keywords: dedupedKeywords.length > 0 ? dedupedKeywords : existing?.keywords || [],
    watchedAt: now,
    watchCount: (existing?.watchCount || 0) + 1,
  };

  const next = [updatedEntry, ...current.filter((e) => e.videoId !== video.videoId)].slice(
    0,
    MAX_ENTRIES,
  );

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota errors
  }
  return next;
}

export function clearWatchHistory(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function getTopTopics(limit = 3): string[] {
  const history = getWatchHistory();
  if (history.length === 0) return [];
  const now = Date.now();
  const weights = new Map<string, number>();

  for (const h of history) {
    const ageHours = Math.max(0, (now - (h.watchedAt || now)) / 3_600_000);
    const decay = Math.exp(-ageHours / 72);
    const w = decay * Math.min(3, h.watchCount || 1);
    const tokens = [...(h.keywords || []), ...extractTopicTokens(h.title || '')];
    for (const tok of tokens) {
      const clean = tok.toLowerCase().trim();
      if (clean.length >= 2 && !STOP_WORDS.has(clean)) {
        weights.set(clean, (weights.get(clean) || 0) + w);
      }
    }
  }

  return [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([t]) => t);
}

export function rankRelatedVideos(
  recommended: RecommendedVideo[],
  currentVideoId: string,
): RecommendedVideo[] {
  const history = getWatchHistory();
  if (history.length === 0 || recommended.length === 0) return recommended;

  const now = Date.now();
  const topicWeights = new Map<string, number>();
  const authorWeights = new Map<string, number>();
  const watchedIds = new Set<string>(history.slice(0, 10).map((h) => h.videoId));

  for (const h of history) {
    const ageHours = Math.max(0, (now - (h.watchedAt || now)) / 3_600_000);
    const decay = Math.exp(-ageHours / 72);
    const w = decay * Math.min(3, h.watchCount || 1);

    if (h.author) {
      authorWeights.set(h.author, (authorWeights.get(h.author) || 0) + w * 1.3);
    }
    for (const tok of [...(h.keywords || []), ...extractTopicTokens(h.title || '')]) {
      const clean = tok.toLowerCase().trim();
      if (clean.length >= 2 && !STOP_WORDS.has(clean)) {
        topicWeights.set(clean, (topicWeights.get(clean) || 0) + w);
      }
    }
  }

  return recommended
    .filter((r) => r.videoId !== currentVideoId)
    .map((rec, originalIdx) => {
      const tokens = extractTopicTokens(rec.title || '');
      let topicScore = 0;
      for (const tok of tokens) {
        topicScore += topicWeights.get(tok) || 0;
      }
      const authorScore = authorWeights.get(rec.author) || 0;
      const seenPenalty = watchedIds.has(rec.videoId) ? -3.0 : 0;
      const baseRankBoost = Math.max(0, (recommended.length - originalIdx) * 0.12);
      const score = topicScore * 1.8 + authorScore * 1.6 + baseRankBoost + seenPenalty;
      return { rec, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.rec);
}
