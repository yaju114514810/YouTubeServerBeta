import type {
  AdaptiveFormat,
  ExternalRecoveryAttempt,
  ExternalRecoveryResponse,
  FormatStream,
} from '../types/invidious';

const BROWSER_CORS_INVIDIOUS = [
  'https://yt.chocolatemoo53.com',
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.perennialte.ch',
  'https://invidious.fdn.fr',
  'https://yewtu.be',
  'https://iv.melmac.space',
  'https://invidious.jing.rocks',
];

const BROWSER_CORS_PIPED = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.darkness.services',
];

let cachedLiveInvidious: { hosts: string[]; fetchedAt: number } | null = null;

async function fetchDynamicLiveInvidiousHosts(): Promise<string[]> {
  if (cachedLiveInvidious && Date.now() - cachedLiveInvidious.fetchedAt < 120_000) {
    return cachedLiveInvidious.hosts;
  }
  const merged = new Set<string>(BROWSER_CORS_INVIDIOUS);
  try {
    const res = await fetch('https://api.invidious.io/instances.json?sort_by=health', {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = (await res.json()) as [string, any][];
      for (const [, meta] of list) {
        if (meta?.type === 'https' && meta?.api && typeof meta?.uri === 'string') {
          merged.add(meta.uri.replace(/\/+$/, ''));
        }
        if (merged.size >= 16) break;
      }
    }
  } catch {
    // keep curated defaults
  }
  const hosts = [...merged];
  cachedLiveInvidious = { hosts, fetchedAt: Date.now() };
  return hosts;
}

export interface BrowserResolvedStreams {
  adaptiveFormats: AdaptiveFormat[];
  formatStreams: FormatStream[];
  hlsManifestUrl?: string;
  hlsProxyUrl?: string;
  sourceHost: string;
  category?: 'invidious' | 'zernio' | 'piped';
  attempts?: ExternalRecoveryAttempt[];
}

export async function syncResolvedStreamsToServer(
  videoId: string,
  resolved: BrowserResolvedStreams,
): Promise<void> {
  try {
    await fetch(`/api/v1/streams/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        adaptiveFormats: resolved.adaptiveFormats,
        formatStreams: resolved.formatStreams,
        hlsManifestUrl: resolved.hlsManifestUrl,
        sourceHost: resolved.sourceHost,
      }),
    });
  } catch {
    // non-fatal background cache sync
  }
}

function mapInvidiousPayload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d: any,
  videoId: string,
  sourceHost: string,
  category: 'invidious' | 'zernio' | 'piped' = 'invidious',
): BrowserResolvedStreams {
  const adaptiveRaw = Array.isArray(d?.adaptiveFormats) ? d.adaptiveFormats : [];
  const formatsRaw = Array.isArray(d?.formatStreams) ? d.formatStreams : [];
  const hlsUrl = typeof d?.hlsUrl === 'string' && d.hlsUrl ? d.hlsUrl : undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adaptiveFormats: AdaptiveFormat[] = adaptiveRaw.map((f: any) => ({
    bitrate: String(f.bitrate || '0'),
    url: String(f.url || ''),
    proxyUrl: `/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(String(f.itag || ''))}`,
    itag: String(f.itag || ''),
    type: String(f.type || ''),
    container: String(f.container || 'mp4'),
    encoding: String(f.encoding || ''),
    qualityLabel: String(f.qualityLabel || ''),
    resolution: String(f.resolution || f.qualityLabel || ''),
    fps: typeof f.fps === 'number' ? f.fps : undefined,
    audioQuality: f.audioQuality,
    audioChannels: f.audioChannels,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const formatStreams: FormatStream[] = formatsRaw.map((f: any) => ({
    url: String(f.url || ''),
    proxyUrl: `/api/v1/stream/googlevideo/${encodeURIComponent(videoId)}?itag=${encodeURIComponent(String(f.itag || ''))}`,
    itag: String(f.itag || ''),
    type: String(f.type || ''),
    quality: String(f.quality || ''),
    container: String(f.container || 'mp4'),
    encoding: String(f.encoding || 'h264'),
    qualityLabel: String(f.qualityLabel || ''),
    resolution: String(f.resolution || f.qualityLabel || ''),
  }));

  const hlsProxyUrl = hlsUrl
    ? `/api/v1/stream/hls-proxy?url=${encodeURIComponent(hlsUrl)}`
    : adaptiveFormats.length > 0 || formatStreams.length > 0
      ? `/api/v1/stream/hls-gen/${encodeURIComponent(videoId)}/index.m3u8`
      : undefined;

  return {
    adaptiveFormats,
    formatStreams,
    hlsManifestUrl: hlsUrl,
    hlsProxyUrl,
    sourceHost,
    category,
  };
}

function mapPipedPayload(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d: any,
  videoId: string,
  sourceHost: string,
  category: 'piped' | 'zernio' = 'piped',
): BrowserResolvedStreams {
  const vList = Array.isArray(d?.videoStreams) ? d.videoStreams : [];
  const aList = Array.isArray(d?.audioStreams) ? d.audioStreams : [];
  const hlsUrl = typeof d?.hls === 'string' && d.hls ? d.hls : undefined;

  const formatStreams: FormatStream[] = vList
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((v: any) => !v.videoOnly && v.url)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((v: any) => ({
      url: String(v.url),
      proxyUrl: `/api/v1/stream/googlevideo/${encodeURIComponent(videoId)}?itag=${encodeURIComponent(String(v.itag || v.quality || '22'))}`,
      itag: String(v.itag || v.quality || '22'),
      type: String(v.mimeType || 'video/mp4'),
      quality: String(v.quality || ''),
      container: String(v.format || 'mp4').toLowerCase(),
      encoding: String(v.codec || 'h264'),
      qualityLabel: String(v.quality || ''),
      resolution: String(v.quality || ''),
    }));

  const adaptiveFormats: AdaptiveFormat[] = [
    ...vList
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((v: any) => v.videoOnly && v.url)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((v: any) => ({
        bitrate: String(v.bitrate || '0'),
        url: String(v.url),
        proxyUrl: `/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(String(v.itag || `v_${v.quality}`))}`,
        itag: String(v.itag || `v_${v.quality}`),
        type: String(v.mimeType || 'video/mp4'),
        container: String(v.format || 'mp4').toLowerCase(),
        encoding: String(v.codec || ''),
        qualityLabel: String(v.quality || ''),
        resolution: String(v.quality || ''),
        fps: typeof v.fps === 'number' ? v.fps : undefined,
      })),
    ...aList
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((a: any) => a.url)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((a: any) => ({
        bitrate: String(a.bitrate || '0'),
        url: String(a.url),
        proxyUrl: `/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(String(a.itag || `a_${a.bitrate}`))}`,
        itag: String(a.itag || `a_${a.bitrate}`),
        type: String(a.mimeType || 'audio/mp4'),
        container: String(a.format || 'm4a').toLowerCase(),
        encoding: String(a.codec || 'opus'),
        qualityLabel: String(a.quality || 'Audio'),
        resolution: '',
        audioQuality: String(a.quality || 'AUDIO_QUALITY_MEDIUM'),
      })),
  ];

  const hlsProxyUrl = hlsUrl
    ? `/api/v1/stream/hls-proxy?url=${encodeURIComponent(hlsUrl)}`
    : adaptiveFormats.length > 0 || formatStreams.length > 0
      ? `/api/v1/stream/hls-gen/${encodeURIComponent(videoId)}/index.m3u8`
      : undefined;

  return {
    adaptiveFormats,
    formatStreams,
    hlsManifestUrl: hlsUrl,
    hlsProxyUrl,
    sourceHost,
    category,
  };
}

export async function resolveStreamsFromBrowserIp(
  videoId: string,
  customInvidiousUrl?: string,
  customZernioUrl?: string,
): Promise<BrowserResolvedStreams | null> {
  const dynamicHosts = await fetchDynamicLiveInvidiousHosts();
  const invHosts = customInvidiousUrl
    ? [customInvidiousUrl.replace(/\/+$/, ''), ...dynamicHosts]
    : dynamicHosts;

  const tasks: Promise<BrowserResolvedStreams>[] = [];

  for (const base of [...new Set(invHosts)].slice(0, 12)) {
    tasks.push(
      (async () => {
        const r = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`, {
          signal: AbortSignal.timeout(4500),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (await r.json()) as any;
        const adaptiveRaw = Array.isArray(d?.adaptiveFormats) ? d.adaptiveFormats : [];
        const formatsRaw = Array.isArray(d?.formatStreams) ? d.formatStreams : [];
        const hlsUrl = typeof d?.hlsUrl === 'string' && d.hlsUrl ? d.hlsUrl : undefined;
        if (adaptiveRaw.length === 0 && formatsRaw.length === 0 && !hlsUrl) {
          throw new Error('empty');
        }
        return mapInvidiousPayload(
          d,
          videoId,
          `invidious:${base.replace(/^https?:\/\//, '')}`,
          'invidious',
        );
      })(),
    );
  }

  // Zernio custom / Piped external servers
  const zernioAndPiped = customZernioUrl
    ? [customZernioUrl.replace(/\/+$/, ''), ...BROWSER_CORS_PIPED]
    : BROWSER_CORS_PIPED;

  for (const base of [...new Set(zernioAndPiped)]) {
    const isCustomZernio = Boolean(customZernioUrl && base === customZernioUrl.replace(/\/+$/, ''));
    tasks.push(
      (async () => {
        // Support both Piped (/streams/:id) and Invidious-style (/api/v1/videos/:id) on custom Zernio URLs
        const urlToTry = isCustomZernio
          ? `${base}/streams/${encodeURIComponent(videoId)}`
          : `${base}/streams/${encodeURIComponent(videoId)}`;
        let r = await fetch(urlToTry, { signal: AbortSignal.timeout(4500) });
        if (!r.ok && isCustomZernio) {
          r = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`, {
            signal: AbortSignal.timeout(4500),
          });
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (await r.json()) as any;
        if (Array.isArray(d?.adaptiveFormats) || Array.isArray(d?.formatStreams)) {
          if (!d.adaptiveFormats?.length && !d.formatStreams?.length && !d.hlsUrl) throw new Error('empty');
          return mapInvidiousPayload(
            d,
            videoId,
            `${isCustomZernio ? 'zernio' : 'piped'}:${base.replace(/^https?:\/\//, '')}`,
            isCustomZernio ? 'zernio' : 'piped',
          );
        }
        const vList = Array.isArray(d?.videoStreams) ? d.videoStreams : [];
        const aList = Array.isArray(d?.audioStreams) ? d.audioStreams : [];
        const hlsUrl = typeof d?.hls === 'string' && d.hls ? d.hls : undefined;
        if (vList.length === 0 && aList.length === 0 && !hlsUrl) throw new Error('empty');
        return mapPipedPayload(
          d,
          videoId,
          `${isCustomZernio ? 'zernio' : 'piped'}:${base.replace(/^https?:\/\//, '')}`,
          isCustomZernio ? 'zernio' : 'piped',
        );
      })(),
    );
  }

  try {
    const winner = await Promise.any(tasks);
    syncResolvedStreamsToServer(videoId, winner).catch(() => {});
    return winner;
  } catch {
    return null;
  }
}

// Comprehensive auto-recovery searching BOTH living server-side & browser-side Invidious + Zernio/Piped nodes
export async function recoverPlaybackFromExternalNodes(
  videoId: string,
  customInvidiousUrl?: string,
  customZernioUrl?: string,
): Promise<{
  resolved: BrowserResolvedStreams | null;
  serverReport: ExternalRecoveryResponse | null;
}> {
  const [browserResult, serverRes] = await Promise.allSettled([
    resolveStreamsFromBrowserIp(videoId, customInvidiousUrl, customZernioUrl),
    fetch(`/api/kuro/external-recover/${encodeURIComponent(videoId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customInvidiousUrl: customInvidiousUrl || '',
        customZernioUrl: customZernioUrl || '',
      }),
      signal: AbortSignal.timeout(9000),
    }).then(async (r) => (r.ok ? ((await r.json()) as ExternalRecoveryResponse) : null)),
  ]);

  const browserWin = browserResult.status === 'fulfilled' ? browserResult.value : null;
  const serverWin = serverRes.status === 'fulfilled' ? serverRes.value : null;

  if (
    browserWin &&
    (browserWin.adaptiveFormats.length > 0 ||
      browserWin.formatStreams.length > 0 ||
      browserWin.hlsManifestUrl)
  ) {
    return {
      resolved: {
        ...browserWin,
        attempts: serverWin?.attempts,
      },
      serverReport: serverWin,
    };
  }

  if (
    serverWin?.ok &&
    (serverWin.adaptiveFormats.length > 0 ||
      serverWin.formatStreams.length > 0 ||
      serverWin.hlsManifestUrl)
  ) {
    return {
      resolved: {
        adaptiveFormats: serverWin.adaptiveFormats,
        formatStreams: serverWin.formatStreams,
        hlsManifestUrl: serverWin.hlsManifestUrl,
        hlsProxyUrl: serverWin.hlsProxyUrl,
        sourceHost: serverWin.recoveredFrom || 'external-server',
        category: serverWin.serverCategory || 'invidious',
        attempts: serverWin.attempts,
      },
      serverReport: serverWin,
    };
  }

  return {
    resolved: null,
    serverReport: serverWin,
  };
}

export async function probeExternalNodeFromBrowser(
  url: string,
): Promise<{ reachable: boolean; latencyMs: number | null }> {
  if (!url || !url.startsWith('http')) {
    return { reachable: true, latencyMs: 1 };
  }
  const clean = url.replace(/\/+$/, '');
  const testTargets = [
    `${clean}/api/v1/stats`,
    `${clean}/trending?region=JP`,
    clean,
  ];
  const t0 = performance.now();
  for (const target of testTargets) {
    try {
      const r = await fetch(target, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        return { reachable: true, latencyMs: Math.max(1, Math.round(performance.now() - t0)) };
      }
    } catch {
      // try next probe path
    }
  }
  return { reachable: false, latencyMs: null };
}

export function triggerDirectDownload(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
