import type { ApiProbeResult, VideoResponse } from '../types/invidious';

export async function probeApi<T>(
  path: string,
  init?: RequestInit,
): Promise<ApiProbeResult<T>> {
  const t0 = performance.now();
  const res = await fetch(path, init);
  const text = await res.text();
  const clientMs = Math.round((performance.now() - t0) * 100) / 100;

  const serverTimeHeader = res.headers.get('X-Response-Time');
  const parsedServerMs = serverTimeHeader
    ? parseFloat(serverTimeHeader.replace(/ms$/i, ''))
    : NaN;

  const latencyMs = Number.isFinite(parsedServerMs) ? parsedServerMs : clientMs;
  const cacheStatus = res.headers.get('X-Cache') || 'NONE';
  const upstreamNode = res.headers.get('X-Upstream-Node') || 'kurostream-edge';
  const payloadBytes = new Blob([text]).size;

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON response (${res.status})`);
  }

  if (!res.ok) {
    const errMsg =
      typeof data === 'object' && data !== null && 'error' in data
        ? String((data as { error?: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(errMsg);
  }

  return {
    data,
    status: res.status,
    latencyMs,
    cacheStatus,
    upstreamNode,
    payloadBytes,
  };
}

const clientVideoCache = new Map<
  string,
  { result: ApiProbeResult<VideoResponse>; cachedAt: number }
>();
const inflightVideoRequests = new Map<string, Promise<ApiProbeResult<VideoResponse>>>();
const CLIENT_VIDEO_TTL_MS = 180_000;

export function updateClientVideoCache(videoId: string, data: VideoResponse, upstreamNode?: string): void {
  const existing = clientVideoCache.get(videoId);
  clientVideoCache.set(videoId, {
    cachedAt: Date.now(),
    result: {
      data,
      status: 200,
      latencyMs: existing?.result.latencyMs ?? 1,
      cacheStatus: 'HIT',
      upstreamNode: upstreamNode || existing?.result.upstreamNode || 'kurostream-edge',
      payloadBytes: existing?.result.payloadBytes ?? 0,
    },
  });
}

export function prefetchVideo(videoId: string): void {
  if (!videoId) return;
  const cached = clientVideoCache.get(videoId);
  if (cached && Date.now() - cached.cachedAt < CLIENT_VIDEO_TTL_MS) return;
  if (inflightVideoRequests.has(videoId)) return;

  const p = probeApi<VideoResponse>(`/api/v1/videos/${encodeURIComponent(videoId)}`, {
    priority: 'low' as RequestPriority,
  })
    .then((res) => {
      clientVideoCache.set(videoId, { result: res, cachedAt: Date.now() });
      return res;
    })
    .finally(() => {
      inflightVideoRequests.delete(videoId);
    });

  inflightVideoRequests.set(videoId, p);
  p.catch(() => {});
}

export function preloadNextVideos(videoIds: string[]): void {
  const unique = [...new Set(videoIds.filter(Boolean))].slice(0, 3);
  unique.forEach((id, idx) => {
    window.setTimeout(() => {
      prefetchVideo(id);
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      img.src = `/api/v1/thumbnail/${encodeURIComponent(id)}/hqdefault`;
    }, idx * 120);
  });
}

export async function fetchVideoCached(videoId: string, refresh = false): Promise<ApiProbeResult<VideoResponse>> {
  if (!refresh) {
    const cached = clientVideoCache.get(videoId);
    if (cached && Date.now() - cached.cachedAt < CLIENT_VIDEO_TTL_MS) {
      return {
        ...cached.result,
        latencyMs: 0.4,
        cacheStatus: 'HIT',
      };
    }
    const inflight = inflightVideoRequests.get(videoId);
    if (inflight) {
      return inflight;
    }
  } else {
    clientVideoCache.delete(videoId);
  }

  const qs = refresh ? '?refresh=true' : '';
  const p = probeApi<VideoResponse>(`/api/v1/videos/${encodeURIComponent(videoId)}${qs}`)
    .then((res) => {
      clientVideoCache.set(videoId, { result: res, cachedAt: Date.now() });
      return res;
    })
    .finally(() => {
      inflightVideoRequests.delete(videoId);
    });

  if (!refresh) {
    inflightVideoRequests.set(videoId, p);
  }
  return p;
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return 'LIVE';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatCompactNumber(num: number): string {
  if (!num || num <= 0) return '0';
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function extractVideoId(input: string): string {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.searchParams.has('v')) return u.searchParams.get('v') || trimmed;
    if (u.hostname.includes('youtu.be')) return u.pathname.replace(/^\//, '').split('/')[0] || trimmed;
    const embedMatch = u.pathname.match(/\/(?:embed|shorts|v)\/([a-zA-Z0-9_-]{11})/);
    if (embedMatch) return embedMatch[1];
  } catch {
    // not a URL
  }
  return trimmed;
}
