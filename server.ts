import express from 'express';
import cors from 'cors';
import compression from 'compression';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { Innertube, Platform, UniversalCache, Log } from 'youtubei.js';
import { BotGuardClient } from 'bgutils-js/botguard';
import { buildURL, parseLooseJSON, getHeaders, USER_AGENT } from 'bgutils-js/utils';
import { WebPoMinter } from 'bgutils-js/webpo';
import { JSDOM } from 'jsdom';
import { Agent, ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { GoogleGenAI, Type } from '@google/genai';
import type {
  AdaptiveFormat,
  AutoFallbackStreamResponse,
  ChannelResponse,
  ClusterServerNode,
  CommentItem,
  CommentsResponse,
  EduEmbedConfig,
  ExternalRecoveryAttempt,
  ExternalRecoveryResponse,
  FallbackAttempt,
  FormatStream,
  InstanceNode,
  InvidiousStats,
  Kuro4kStreamResponse,
  KuroBatchMetaItem,
  KuroBatchMetaResponse,
  KuroEdgeShieldResponse,
  LiveServerCheckItem,
  LiveServersResponse,
  PersonalizedFeedResponse,
  RecommendedVideo,
  SearchVideoItem,
  ServerTier,
  ShieldAuditEntry,
  ShieldRules,
  StreamConfigStatus,
  TranslateResponse,
  VideoResponse,
  VideoThumbnail,
  WatchHistoryEntry,
  YouTubeAuthStatus,
} from './src/types/invidious.ts';

// Keep youtubei.js parser warnings quiet in production logs
Log.setLevel(Log.Level.NONE);

// Enable JS player deciphering in youtubei.js
// eslint-disable-next-line @typescript-eslint/no-explicit-any
Platform.shim.eval = async (data: any) => new Function(data.output)();

const FFMPEG_BIN = fs.existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg';
const FFMPEG_AVAILABLE = fs.existsSync('/usr/bin/ffmpeg');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3000;
const START_TIME = Date.now();

// ---------------------------------------------------------------------------
// Ultra-Fast L1 LRU Memory Cache + Metrics
// ---------------------------------------------------------------------------
interface CacheEntry<T = unknown> {
  data: T;
  expiresAt: number;
  staleUntil: number;
  source: string;
}

const CACHE_MAX_ITEMS = 600;
const edgeCache = new Map<string, CacheEntry>();

const metrics = {
  hits: 0,
  misses: 0,
  totalLatencyMs: 0,
  totalRequests: 0,
};

function cacheGet<T>(key: string): { hit: boolean; stale: boolean; data?: T; source?: string } {
  const entry = edgeCache.get(key);
  if (!entry) return { hit: false, stale: false };
  const now = Date.now();
  if (now > entry.staleUntil) {
    edgeCache.delete(key);
    return { hit: false, stale: false };
  }
  // Refresh LRU order
  edgeCache.delete(key);
  edgeCache.set(key, entry);
  return {
    hit: true,
    stale: now > entry.expiresAt,
    data: entry.data as T,
    source: entry.source,
  };
}

function cacheSet<T>(key: string, data: T, ttlMs: number, source: string): void {
  if (edgeCache.size >= CACHE_MAX_ITEMS) {
    const oldestKey = edgeCache.keys().next().value;
    if (oldestKey !== undefined) edgeCache.delete(oldestKey);
  }
  const now = Date.now();
  edgeCache.set(key, {
    data,
    expiresAt: now + ttlMs,
    staleUntil: now + ttlMs * 3,
    source,
  });
}

// ---------------------------------------------------------------------------
// Stream Runtime Config & BotGuard PO Token Minter + Singleton InnerTube
// ---------------------------------------------------------------------------
const OAUTH_CACHE_FILE = '/tmp/kurostream-oauth.json';

const streamConfig = {
  cookies: process.env.YT_COOKIES || '',
  customUpstreamUrl: (process.env.INVIDIOUS_UPSTREAM_URL || '').replace(/\/+$/, ''),
  outboundProxyUrl: (process.env.YT_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim(),
};

const keepAliveDispatcher = new Agent({
  connections: 64,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
});

let outboundDispatcher: Dispatcher | undefined;
let cachedProxyUrl = '';

function getOutboundDispatcher(): Dispatcher {
  const url = streamConfig.outboundProxyUrl;
  if (!url) {
    outboundDispatcher = undefined;
    cachedProxyUrl = '';
    return keepAliveDispatcher;
  }
  if (outboundDispatcher && cachedProxyUrl === url) {
    return outboundDispatcher;
  }
  try {
    outboundDispatcher = url.toLowerCase().startsWith('socks')
      ? new Socks5ProxyAgent(url)
      : new ProxyAgent(url);
    cachedProxyUrl = url;
    return outboundDispatcher;
  } catch {
    outboundDispatcher = undefined;
    cachedProxyUrl = '';
    return keepAliveDispatcher;
  }
}

function proxiedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const dispatcher = getOutboundDispatcher();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return undiciFetch(input as any, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(init as any),
    dispatcher,
  }) as unknown as Promise<Response>;
}

const PRIVACY_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
];

function getUpstreamUaForUrl(targetUrl?: string): string {
  if (targetUrl) {
    if (/[?&]c=IOS(?:&|$)/i.test(targetUrl)) {
      return 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)';
    }
    if (/[?&]c=ANDROID(?:_VR)?(?:&|$)/i.test(targetUrl)) {
      return 'com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip';
    }
  }
  return PRIVACY_USER_AGENTS[0];
}

function buildMaskedUpstreamHeaders(rangeHeader?: string, targetUrl?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': getUpstreamUaForUrl(targetUrl),
    Accept: '*/*',
    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    'Sec-Fetch-Dest': 'video',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
  };
  if (rangeHeader) {
    headers['Range'] = rangeHeader;
  }
  return headers;
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h.endsWith('.local') ||
    h.startsWith('127.') ||
    h.startsWith('10.') ||
    h.startsWith('192.168.') ||
    h.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)
  ) {
    return true;
  }
  return false;
}

function buildEduEmbedConfig(
  videoId: string,
  title = '',
  author = '',
  embeddable = true,
  lang = 'ja',
  reqOrigin?: string,
): EduEmbedConfig {
  const baseParams: Record<string, string> = {
    enablejsapi: '1',
    rel: '0',
    playsinline: '1',
    iv_load_policy: '3',
    modestbranding: '1',
    hl: lang,
    cc_lang_pref: lang,
  };
  if (reqOrigin && /^https?:\/\//i.test(reqOrigin)) {
    baseParams.origin = reqOrigin;
    baseParams.widget_referrer = reqOrigin;
  }

  const classroomParams = new URLSearchParams(baseParams);
  const kahootParams = new URLSearchParams({
    ...baseParams,
    autoplay: '1',
    controls: '1',
    fs: '1',
  });
  const eduParams = new URLSearchParams(baseParams);
  const nocookieParams = new URLSearchParams({
    ...baseParams,
    autoplay: '1',
    controls: '1',
    fs: '1',
  });

  const baseEduUrl = `https://www.youtubeeducation.com/embed/${encodeURIComponent(videoId)}`;

  return {
    videoId,
    title: title || `Video ${videoId}`,
    author: author || 'YouTube Education',
    classroomUrl: `${baseEduUrl}?${classroomParams.toString()}`,
    kahootUrl: `${baseEduUrl}?${kahootParams.toString()}`,
    nocookieUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${nocookieParams.toString()}`,
    educationUrl: `${baseEduUrl}?${eduParams.toString()}`,
    embeddable,
    proxyFallbackAvailable: true,
    providerNote:
      '正規 YouTube Education (youtubeeducation.com) + IFrame API連携 + サーバープロキシEduフォールバック対応',
  };
}

let oauthState: YouTubeAuthStatus = { status: 'idle' };

function loadSavedOAuthTokens() {
  try {
    if (!fs.existsSync(OAUTH_CACHE_FILE)) return null;
    const raw = fs.readFileSync(OAUTH_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.access_token && parsed.refresh_token) return parsed;
  } catch {
    // ignore corrupt token cache
  }
  return null;
}

function saveOAuthTokens(tokens: unknown): void {
  try {
    fs.writeFileSync(OAUTH_CACHE_FILE, JSON.stringify(tokens), { mode: 0o600 });
  } catch {
    // ignore fs errors
  }
}

function clearSavedOAuthTokens(): void {
  try {
    if (fs.existsSync(OAUTH_CACHE_FILE)) fs.unlinkSync(OAUTH_CACHE_FILE);
  } catch {
    // ignore
  }
}

function clearVideoAndStreamCaches(): void {
  for (const key of edgeCache.keys()) {
    if (key.startsWith('video:') || key.startsWith('stream:') || key.startsWith('kuro4k:')) {
      edgeCache.delete(key);
    }
  }
}

interface MinterState {
  minter: WebPoMinter;
  visitorData: string;
  coldPot: string;
}

let minterPromise: Promise<MinterState | null> | null = null;
let minterReady = false;

function getWebPoMinter(): Promise<MinterState | null> {
  if (!minterPromise) {
    minterPromise = (async (): Promise<MinterState | null> => {
      try {
        const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
          url: 'https://www.youtube.com',
          referrer: 'https://www.youtube.com/',
        });
        const pageHtml = await (
          await proxiedFetch('https://www.youtube.com', {
            headers: { accept: '*/*', 'user-agent': USER_AGENT },
            signal: AbortSignal.timeout(5000),
          })
        ).text();

        const ytConfigStr = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
        if (!ytConfigStr) return null;
        const ytCfg = JSON.parse(ytConfigStr);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (dom.window as any).yt = { config_: ytCfg };
        Object.assign(globalThis, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          yt: (dom.window as any).yt,
          window: dom.window,
          document: dom.window.document,
          location: dom.window.location,
          origin: dom.window.origin,
        });
        if (!('navigator' in globalThis)) {
          Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });
        }

        const initialAttestationData = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
        if (!initialAttestationData) return null;
        const json = parseLooseJSON(initialAttestationData[1]);
        const challengeResponse = json?.R;
        const interpreterUrl =
          challengeResponse?.bgChallenge?.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
        if (!interpreterUrl) return null;

        const interpreterJs = await (
          await proxiedFetch(`https:${interpreterUrl}`, { signal: AbortSignal.timeout(5000) })
        ).text();
        new Function(interpreterJs)();

        const bg = await BotGuardClient.create({
          program: challengeResponse.bgChallenge.program,
          globalName: challengeResponse.bgChallenge.globalName,
          globalObject: globalThis,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const webPoSignalOutput: any[] = [];
        const bgRes = await bg.snapshot({ webPoSignalOutput });
        const itRes = (await (
          await proxiedFetch(buildURL('GenerateIT', true), {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(['O43z0dpjhgX20SCx4KAo', bgRes]),
            signal: AbortSignal.timeout(5000),
          })
        ).json()) as [string, number, number, string];

        const minter = await WebPoMinter.create(
          {
            integrityToken: itRes[0],
            estimatedTtlSecs: itRes[1],
            mintRefreshThreshold: itRes[2],
            websafeFallbackToken: itRes[3],
          },
          webPoSignalOutput,
        );
        const visitorData = String(ytCfg.VISITOR_DATA || '');
        const coldPot = visitorData ? await minter.mintAsWebsafeString(visitorData).catch(() => '') : '';
        minterReady = true;
        return {
          minter,
          visitorData,
          coldPot,
        };
      } catch {
        return null;
      }
    })();
  }
  return minterPromise;
}

let ytPromise: Promise<Innertube> | null = null;

function resetYtSession(): void {
  ytPromise = null;
  minterPromise = null;
  minterReady = false;
  clearVideoAndStreamCaches();
}

function attachOAuthListeners(yt: Innertube): void {
  yt.session.on('auth', (data) => {
    saveOAuthTokens(data.credentials);
    oauthState = { status: 'authorized' };
    clearVideoAndStreamCaches();
  });
  yt.session.on('update-credentials', (data) => {
    saveOAuthTokens(data.credentials);
    oauthState = { status: 'authorized' };
  });
  yt.session.on('auth-error', (err) => {
    oauthState = {
      status: 'error',
      error: err instanceof Error ? err.message : 'YouTube OAuth 認証に失敗しました',
    };
  });
}

function getYt(): Promise<Innertube> {
  if (!ytPromise) {
    ytPromise = (async () => {
      const po = await getWebPoMinter().catch(() => null);
      const yt = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
        lang: 'ja',
        location: 'JP',
        cookie: streamConfig.cookies || undefined,
        visitor_data: po?.visitorData || undefined,
        po_token: po?.coldPot || undefined,
        fetch: proxiedFetch,
      });
      attachOAuthListeners(yt);

      const savedTokens = loadSavedOAuthTokens();
      if (savedTokens) {
        try {
          await yt.session.signIn(savedTokens);
          if (yt.session.logged_in) {
            oauthState = { status: 'authorized' };
          }
        } catch {
          clearSavedOAuthTokens();
          oauthState = { status: 'idle' };
        }
      }
      return yt;
    })().catch((err) => {
      ytPromise = null;
      throw err;
    });
  }
  return ytPromise;
}

// Warm up immediately on boot so the first API call is fast
getYt().catch(() => {});

// ---------------------------------------------------------------------------
// Helpers: Thumbnails, Duration, View Parsing, HTML Escaping
// ---------------------------------------------------------------------------
function buildThumbnails(videoId: string): VideoThumbnail[] {
  return [
    { quality: 'maxres', url: `/api/v1/thumbnail/${videoId}/maxresdefault`, width: 1280, height: 720 },
    { quality: 'maxresdefault', url: `/api/v1/thumbnail/${videoId}/maxresdefault`, width: 1280, height: 720 },
    { quality: 'sddefault', url: `/api/v1/thumbnail/${videoId}/sddefault`, width: 640, height: 480 },
    { quality: 'high', url: `/api/v1/thumbnail/${videoId}/hqdefault`, width: 480, height: 360 },
    { quality: 'medium', url: `/api/v1/thumbnail/${videoId}/mqdefault`, width: 320, height: 180 },
    { quality: 'default', url: `/api/v1/thumbnail/${videoId}/default`, width: 120, height: 90 },
  ];
}

function proxyMediaUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  if (rawUrl.startsWith('/api/')) return rawUrl;
  const normalized = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
  if (!/^https?:\/\//i.test(normalized)) return '';
  return `/api/v1/media-proxy?url=${encodeURIComponent(normalized)}`;
}

function parseDurationToSeconds(text?: string | number | null): number {
  if (typeof text === 'number' && Number.isFinite(text)) return text;
  if (!text || typeof text !== 'string') return 0;
  const parts = text.trim().split(':').map((p) => Number(p.replace(/[^\d]/g, '')));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function parseViewCount(text?: string | number | null): number {
  if (typeof text === 'number' && Number.isFinite(text)) return text;
  if (!text || typeof text !== 'string') return 0;
  const cleaned = text.replace(/,/g, '').trim();
  const numMatch = cleaned.match(/([\d.]+)\s*(万|億|K|M|B)?/i);
  if (!numMatch) {
    const digits = Number(cleaned.replace(/[^\d]/g, ''));
    return Number.isFinite(digits) ? digits : 0;
  }
  const base = parseFloat(numMatch[1]);
  const unit = (numMatch[2] || '').toUpperCase();
  if (unit === '万') return Math.round(base * 10_000);
  if (unit === '億') return Math.round(base * 100_000_000);
  if (unit === 'K') return Math.round(base * 1_000);
  if (unit === 'M') return Math.round(base * 1_000_000);
  if (unit === 'B') return Math.round(base * 1_000_000_000);
  return Math.round(base);
}

function asText(val: unknown): string {
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object') {
    const obj = val as { text?: unknown; toString?: () => string };
    if (typeof obj.text === 'string') return obj.text;
    if (obj.text !== undefined) return asText(obj.text);
    if (typeof obj.toString === 'function') {
      const s = obj.toString();
      if (s && s !== '[object Object]') return s;
    }
  }
  return val == null ? '' : String(val);
}

function escapeHtml(str: unknown): string {
  return asText(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textToHtml(text: unknown): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function formatViewsLabel(count: number): string {
  if (!count) return '0 views';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M views`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K views`;
  return `${count.toLocaleString()} views`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRawVideoItem(v: any): SearchVideoItem | null {
  if (!v) return null;

  // Handle YouTube LockupView (used by modern watch_next_feed / related videos)
  if (v.type === 'LockupView' || v.content_id) {
    if (v.content_type && v.content_type !== 'VIDEO') return null;
    const lockupId = typeof v.content_id === 'string' ? v.content_id : '';
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(lockupId)) return null;

    const title = asText(v?.metadata?.title) || 'Untitled Video';
    const rows = Array.isArray(v?.metadata?.metadata?.metadata_rows)
      ? v.metadata.metadata.metadata_rows
      : [];
    const author = asText(rows[0]?.metadata_parts?.[0]?.text) || 'YouTube Creator';
    const metaParts = Array.isArray(rows[1]?.metadata_parts) ? rows[1].metadata_parts : [];
    const viewText = asText(metaParts[0]?.text) || '';
    const publishedText = asText(metaParts[1]?.text) || '';
    const viewCount = parseViewCount(viewText);

    let durationText = '';
    const overlays = Array.isArray(v?.content_image?.overlays) ? v.content_image.overlays : [];
    for (const ov of overlays) {
      const badgeText = asText(ov?.badges?.[0]?.text);
      if (badgeText && /\d+:\d+/.test(badgeText)) {
        durationText = badgeText;
        break;
      }
    }
    const lengthSeconds = parseDurationToSeconds(durationText);
    const is4k = /\b(4k|8k|2160p|uhd|hdr)\b/i.test(title);

    return {
      type: 'video',
      title,
      videoId: lockupId,
      author,
      authorId: '',
      authorUrl: '',
      authorVerified: false,
      videoThumbnails: buildThumbnails(lockupId),
      description: '',
      descriptionHtml: '',
      viewCount,
      viewCountText: viewText || formatViewsLabel(viewCount),
      published: Math.floor(Date.now() / 1000),
      publishedText,
      lengthSeconds,
      liveNow: durationText.toUpperCase() === 'LIVE',
      is4k,
      authorThumbnails: [],
    };
  }

  const videoId = v?.id || v?.video_id;
  if (!videoId || typeof videoId !== 'string') return null;

  const title = asText(v?.title) || 'Untitled Video';
  const author = asText(v?.author?.name || v?.author) || 'Unknown Creator';
  const authorId = asText(v?.author?.id);
  const viewText =
    asText(v?.view_count?.text ?? v?.short_view_count?.text) ||
    (typeof v?.view_count === 'number' ? formatViewsLabel(v.view_count) : '');
  const viewCount = parseViewCount(viewText || v?.view_count);
  const lengthSeconds =
    typeof v?.duration?.seconds === 'number'
      ? v.duration.seconds
      : parseDurationToSeconds(asText(v?.duration));
  const publishedText = asText(v?.published);
  const desc = asText(v?.description_snippet) || asText(v?.snippets?.[0]?.text);
  const badges: string[] = Array.isArray(v?.badges)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ? v.badges.map((b: any) => asText(b?.label || b?.text)).filter(Boolean)
    : [];
  const is4k =
    /\b(4k|8k|2160p|uhd|hdr)\b/i.test(title) ||
    badges.some((b) => /4k|uhd|hdr/i.test(b));

  const authorThumb = v?.author?.thumbnails?.[0]?.url;

  return {
    type: 'video',
    title,
    videoId,
    author,
    authorId,
    authorUrl: authorId ? `/channel/${authorId}` : '',
    authorVerified: Boolean(v?.author?.is_verified || v?.author?.is_verified_artist),
    videoThumbnails: buildThumbnails(videoId),
    description: desc,
    descriptionHtml: textToHtml(desc),
    viewCount,
    viewCountText: viewText || formatViewsLabel(viewCount),
    published: Math.floor(Date.now() / 1000),
    publishedText,
    lengthSeconds,
    liveNow: Boolean(v?.is_live),
    is4k,
    authorThumbnails: authorThumb
      ? [{ url: proxyMediaUrl(authorThumb), width: 68, height: 68 }]
      : [],
  };
}

// ---------------------------------------------------------------------------
// High-Performance Multi-Source Invidious + Zernio + Piped Live Node Engine
// ---------------------------------------------------------------------------
const FALLBACK_INVIDIOUS_HOSTS = [
  'inv.nadeko.net',
  'invidious.nerdvpn.de',
  'yewtu.be',
  'invidious.fdn.fr',
  'invidious.perennialte.ch',
  'iv.melmac.space',
  'yt.chocolatemoo53.com',
  'invidious.jing.rocks',
  'inv.tux.pizza',
  'invidious.protokolla.fi',
  'iv.datura.network',
  'invidious.lunar.icu',
  'invidious.materialio.us',
  'invidious.snopyta.org',
];

const CURATED_PIPED_NODES = [
  { name: 'Piped Kavin', url: 'https://pipedapi.kavin.rocks', region: 'EU-Global' },
  { name: 'Piped Leptons', url: 'https://pipedapi.leptons.xyz', region: 'EU-DE' },
  { name: 'Piped AdminForge', url: 'https://pipedapi.adminforge.de', region: 'EU-DE' },
  { name: 'Piped PrivateCoffee', url: 'https://api.piped.private.coffee', region: 'EU-AT' },
  { name: 'Piped MooMoo', url: 'https://pipedapi.moomoo.me', region: 'US' },
  { name: 'Piped Darkness', url: 'https://pipedapi.darkness.services', region: 'EU' },
  { name: 'Piped ReallyAwesome', url: 'https://pipedapi.reallyaweso.me', region: 'EU' },
  { name: 'Piped PrivacyDE', url: 'https://piped-api.privacy.com.de', region: 'EU-DE' },
  { name: 'Piped SMNZ', url: 'https://pipedapi.smnz.de', region: 'EU-DE' },
  { name: 'Piped Syncpundit', url: 'https://pipedapi.syncpundit.io', region: 'US' },
  { name: 'Piped ProjectSegfault', url: 'https://api.piped.projectsegfau.lt', region: 'EU' },
  { name: 'Piped Segfault IN', url: 'https://pipedapi.in.projectsegfau.lt', region: 'IN' },
];

const ZERNIO_DISCOVERY_BASES = [
  { id: 'zernio-api', name: 'Zernio API (api.zernio.com)', url: 'https://api.zernio.com', region: 'Global' },
  { id: 'zernio-web', name: 'Zernio Gateway (zernio.com)', url: 'https://zernio.com', region: 'Global' },
  { id: 'zernio-app', name: 'Zernio Edge (app.zernio.com)', url: 'https://app.zernio.com', region: 'Global' },
];

interface ExternalNodeHealthRecord {
  url: string;
  category: 'invidious' | 'zernio' | 'piped';
  alive: boolean;
  streamVerified: boolean;
  latencyMs: number;
  score: number;
  statusCode: number | null;
  lastCheckedAt: number;
  consecutiveFailures: number;
  region?: string;
  version?: string;
  cors?: boolean;
  note?: string;
}

const externalNodeRegistry = new Map<string, ExternalNodeHealthRecord>();

function recordExternalNodeOutcome(
  url: string,
  category: 'invidious' | 'zernio' | 'piped',
  ok: boolean,
  streamVerified: boolean,
  latencyMs: number,
  statusCode: number | null,
  extra?: Partial<ExternalNodeHealthRecord>,
): void {
  const cleanUrl = url.replace(/\/+$/, '');
  const prev = externalNodeRegistry.get(cleanUrl);
  const failures = ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
  const ewmaLatency = prev && prev.latencyMs > 0 ? Math.round(prev.latencyMs * 0.4 + latencyMs * 0.6) : latencyMs;

  let score = 0;
  if (ok) {
    score = 55;
    if (streamVerified) score += 35;
    if (ewmaLatency < 400) score += 10;
    else if (ewmaLatency < 1000) score += 6;
    else if (ewmaLatency < 2000) score += 2;
  } else if (statusCode === 401 || statusCode === 403) {
    score = category === 'zernio' ? 40 : Math.max(0, 15 - failures * 5);
  } else {
    score = Math.max(0, (prev?.score ?? 10) - failures * 15);
  }

  externalNodeRegistry.set(cleanUrl, {
    url: cleanUrl,
    category,
    alive: ok,
    streamVerified: streamVerified || Boolean(ok && prev?.streamVerified),
    latencyMs: ewmaLatency,
    score: Math.min(100, Math.max(0, score)),
    statusCode,
    lastCheckedAt: Date.now(),
    consecutiveFailures: failures,
    region: extra?.region ?? prev?.region,
    version: extra?.version ?? prev?.version,
    cors: extra?.cors ?? prev?.cors ?? true,
    note: extra?.note ?? prev?.note,
  });
}

async function discoverDynamicExternalPools(customInvidiousUrl?: string, customZernioUrl?: string): Promise<{
  invidious: { domain: string; uri: string; region: string; cors: boolean; uptimeHint: number }[];
  piped: { name: string; url: string; region: string }[];
  zernio: { id: string; name: string; url: string; region: string }[];
}> {
  const invMap = new Map<string, { domain: string; uri: string; region: string; cors: boolean; uptimeHint: number }>();

  if (customInvidiousUrl && /^https?:\/\//i.test(customInvidiousUrl)) {
    const clean = customInvidiousUrl.replace(/\/+$/, '');
    invMap.set(clean, { domain: `${clean.replace(/^https?:\/\//, '')} (カスタム)`, uri: clean, region: 'Custom', cors: true, uptimeHint: 100 });
  }
  if (streamConfig.customUpstreamUrl && /^https?:\/\//i.test(streamConfig.customUpstreamUrl)) {
    const clean = streamConfig.customUpstreamUrl.replace(/\/+$/, '');
    invMap.set(clean, { domain: `${clean.replace(/^https?:\/\//, '')} (接続設定)`, uri: clean, region: 'Custom', cors: true, uptimeHint: 99 });
  }

  const pipedMap = new Map<string, { name: string; url: string; region: string }>();
  for (const p of CURATED_PIPED_NODES) pipedMap.set(p.url, p);

  const [invRes, pipedRes] = await Promise.allSettled([
    proxiedFetch('https://api.invidious.io/instances.json?sort_by=health', {
      headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
      signal: AbortSignal.timeout(3200),
    }),
    proxiedFetch('https://piped-instances.kavin.rocks', {
      headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
      signal: AbortSignal.timeout(3200),
    }),
  ]);

  if (invRes.status === 'fulfilled' && invRes.value.ok) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = (await invRes.value.json()) as [string, any][];
      for (const [domain, meta] of list) {
        if (meta?.type === 'https' && meta?.api) {
          const uri = String(meta.uri || `https://${domain}`).replace(/\/+$/, '');
          const ratio = Number(meta?.monitor?.['30dRatio']?.ratio ?? meta?.monitor?.['7dRatio']?.ratio ?? 90);
          if (!invMap.has(uri)) {
            invMap.set(uri, {
              domain,
              uri,
              region: String(meta.region || 'Global'),
              cors: Boolean(meta.cors),
              uptimeHint: Number.isFinite(ratio) ? ratio : 85,
            });
          }
          if (invMap.size >= 30) break;
        }
      }
    } catch {
      // ignore json error
    }
  }

  if (pipedRes.status === 'fulfilled' && pipedRes.value.ok) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = (await pipedRes.value.json()) as any[];
      if (Array.isArray(list)) {
        for (const item of list) {
          const apiUrl = typeof item?.api_url === 'string' ? item.api_url.replace(/\/+$/, '') : '';
          if (apiUrl.startsWith('https://') && !pipedMap.has(apiUrl)) {
            pipedMap.set(apiUrl, {
              name: String(item.name || apiUrl.replace(/^https?:\/\//, '')),
              url: apiUrl,
              region: String(item.locations || 'Global'),
            });
          }
          if (pipedMap.size >= 20) break;
        }
      }
    } catch {
      // ignore json error
    }
  }

  for (const host of FALLBACK_INVIDIOUS_HOSTS) {
    const uri = `https://${host}`;
    if (!invMap.has(uri)) {
      invMap.set(uri, { domain: host, uri, region: 'Global', cors: true, uptimeHint: 75 });
    }
  }

  const zernio = [...ZERNIO_DISCOVERY_BASES];
  if (customZernioUrl && /^https?:\/\//i.test(customZernioUrl)) {
    const clean = customZernioUrl.replace(/\/+$/, '');
    zernio.unshift({
      id: 'zernio-custom',
      name: `カスタム Zernio サーバー (${clean.replace(/^https?:\/\//, '')})`,
      url: clean,
      region: 'Custom',
    });
  }

  return {
    invidious: [...invMap.values()],
    piped: [...pipedMap.values()],
    zernio,
  };
}

function getRankedExternalCandidates(category: 'invidious' | 'zernio' | 'piped', fallbackUrls: string[]): string[] {
  const combined = new Set<string>(fallbackUrls.map((u) => u.replace(/\/+$/, '')));
  for (const rec of externalNodeRegistry.values()) {
    if (rec.category === category && (rec.alive || rec.streamVerified)) {
      combined.add(rec.url);
    }
  }
  return [...combined].sort((a, b) => {
    const ra = externalNodeRegistry.get(a);
    const rb = externalNodeRegistry.get(b);
    const sa = ra ? (ra.streamVerified ? 200 : 0) + ra.score : 30;
    const sb = rb ? (rb.streamVerified ? 200 : 0) + rb.score : 30;
    if (sb !== sa) return sb - sa;
    return (ra?.latencyMs ?? 1500) - (rb?.latencyMs ?? 1500);
  });
}

async function discoverUpstreamNodes(): Promise<InstanceNode[]> {
  const cached = cacheGet<InstanceNode[]>('instances:list');
  if (cached.hit && !cached.stale && cached.data) return cached.data;

  const pools = await discoverDynamicExternalPools();
  const probed = await Promise.all(
    pools.invidious.slice(0, 12).map(async (node): Promise<InstanceNode> => {
      const t0 = performance.now();
      try {
        const res = await proxiedFetch(`${node.uri}/api/v1/stats`, {
          headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
          signal: AbortSignal.timeout(2500),
        });
        const latencyMs = Math.round(performance.now() - t0);
        if (!res.ok) {
          recordExternalNodeOutcome(node.uri, 'invidious', false, false, latencyMs, res.status, { region: node.region, cors: node.cors });
          return {
            domain: node.domain,
            uri: node.uri,
            region: node.region,
            type: 'https',
            apiEnabled: true,
            cors: node.cors,
            status: 'degraded',
            latencyMs,
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json = (await res.json()) as any;
        const ver = json?.software?.version || '2.x';
        recordExternalNodeOutcome(node.uri, 'invidious', true, false, latencyMs, res.status, {
          region: node.region,
          cors: node.cors,
          version: ver,
        });
        return {
          domain: node.domain,
          uri: node.uri,
          region: node.region,
          type: 'https',
          apiEnabled: true,
          cors: node.cors,
          status: latencyMs < 1200 ? 'online' : 'degraded',
          latencyMs,
          version: ver,
        };
      } catch {
        recordExternalNodeOutcome(node.uri, 'invidious', false, false, 2500, null, { region: node.region, cors: node.cors });
        return {
          domain: node.domain,
          uri: node.uri,
          region: node.region,
          type: 'https',
          apiEnabled: true,
          cors: node.cors,
          status: 'offline',
          latencyMs: null,
        };
      }
    }),
  );

  const selfNode: InstanceNode = {
    domain: '0.0.0.0:3000 → 127.0.0.1:3001-3005 (5ストリームサーバー構成)',
    uri: '',
    region: 'JP-Edge (5-Server Stream Cluster)',
    type: 'https',
    apiEnabled: true,
    cors: true,
    status: 'online',
    latencyMs: 1,
    version: '3.0.0-headless-5x',
    isSelf: true,
  };

  const finalNodes = [selfNode, ...probed.sort((a, b) => (a.latencyMs ?? 99999) - (b.latencyMs ?? 99999))];
  cacheSet('instances:list', finalNodes, 60_000, 'node-prober');
  return finalNodes;
}

// Proxy-First External Invidious + Piped + Zernio Video/Search/Comments/Channel Extractors
async function fetchVideoViaExternalProxy(videoId: string): Promise<Partial<VideoResponse> | null> {
  const defaultInv = [
    ...(streamConfig.customUpstreamUrl ? [streamConfig.customUpstreamUrl] : []),
    ...FALLBACK_INVIDIOUS_HOSTS.slice(0, 8).map((h) => `https://${h}`),
  ];
  const invCandidates = getRankedExternalCandidates('invidious', defaultInv).slice(0, 8);
  const pipedCandidates = getRankedExternalCandidates(
    'piped',
    CURATED_PIPED_NODES.slice(0, 6).map((p) => p.url),
  ).slice(0, 5);

  const invTasks = invCandidates.map(async (baseUrl) => {
    const t0 = performance.now();
    const res = await proxiedFetch(`${baseUrl}/api/v1/videos/${encodeURIComponent(videoId)}`, {
      headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
      signal: AbortSignal.timeout(3000),
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) {
      recordExternalNodeOutcome(baseUrl, 'invidious', false, false, ms, res.status);
      throw new Error(`HTTP ${res.status}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as any;
    const hasMeta = Boolean(data && data.title);
    const hasStreams = Boolean(data?.adaptiveFormats?.length || data?.formatStreams?.length || data?.hlsUrl);
    if (!hasMeta && !hasStreams) throw new Error('Incomplete payload');
    recordExternalNodeOutcome(baseUrl, 'invidious', true, hasStreams, ms, res.status);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawAdaptive: AdaptiveFormat[] = (data.adaptiveFormats || []).filter((f: any) => f?.url).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (f: any): AdaptiveFormat => ({
        bitrate: String(f.bitrate || '0'),
        url: String(f.url),
        proxyUrl: `/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(String(f.itag || ''))}`,
        itag: String(f.itag || ''),
        type: String(f.type || ''),
        container: String(f.container || 'webm'),
        encoding: String(f.encoding || 'vp9'),
        qualityLabel: String(f.qualityLabel || ''),
        resolution: String(f.resolution || f.qualityLabel || ''),
        fps: typeof f.fps === 'number' ? f.fps : undefined,
        audioQuality: f.audioQuality,
        audioChannels: f.audioChannels,
      }),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawFormats: FormatStream[] = (data.formatStreams || []).filter((f: any) => f?.url).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (f: any): FormatStream => ({
        url: String(f.url),
        proxyUrl: `/api/v1/stream/googlevideo/${encodeURIComponent(videoId)}?itag=${encodeURIComponent(String(f.itag || ''))}`,
        itag: String(f.itag || ''),
        type: String(f.type || ''),
        quality: String(f.quality || ''),
        container: String(f.container || 'mp4'),
        encoding: String(f.encoding || 'h264'),
        qualityLabel: String(f.qualityLabel || ''),
        resolution: String(f.resolution || f.qualityLabel || ''),
      }),
    );

    const recommendedVideos: RecommendedVideo[] = (Array.isArray(data.recommendedVideos) ? data.recommendedVideos : [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((r: any) => r?.videoId && r.videoId !== videoId)
      .slice(0, 20)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any): RecommendedVideo => ({
        videoId: String(r.videoId),
        title: String(r.title || 'Untitled Video'),
        videoThumbnails: buildThumbnails(String(r.videoId)),
        author: String(r.author || 'YouTube Creator'),
        authorId: String(r.authorId || ''),
        lengthSeconds: Number(r.lengthSeconds || 0),
        viewCountText: String(r.viewCountText || formatViewsLabel(Number(r.viewCount || 0))),
        viewCount: Number(r.viewCount || 0),
      }));

    return {
      title: data.title ? String(data.title) : undefined,
      author: data.author ? String(data.author) : undefined,
      authorId: data.authorId ? String(data.authorId) : undefined,
      description: data.description ? String(data.description) : undefined,
      viewCount: typeof data.viewCount === 'number' ? data.viewCount : undefined,
      lengthSeconds: typeof data.lengthSeconds === 'number' ? data.lengthSeconds : undefined,
      publishedText: data.publishedText ? String(data.publishedText) : undefined,
      authorThumbnails: data.authorThumbnails?.[0]?.url
        ? [{ url: proxyMediaUrl(String(data.authorThumbnails[0].url)), width: 88, height: 88 }]
        : undefined,
      recommendedVideos,
      adaptiveFormats: rawAdaptive,
      formatStreams: rawFormats,
      hlsManifestUrl: typeof data.hlsUrl === 'string' && data.hlsUrl ? data.hlsUrl : undefined,
      directStreamAvailable: rawAdaptive.length > 0 || rawFormats.length > 0 || Boolean(data.hlsUrl),
      upstreamSource: `invidious-proxy:${baseUrl.replace(/^https?:\/\//, '')}`,
    } as Partial<VideoResponse>;
  });

  const pipedTasks = pipedCandidates.map(async (baseUrl) => {
    const t0 = performance.now();
    const res = await proxiedFetch(`${baseUrl}/streams/${encodeURIComponent(videoId)}`, {
      headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
      signal: AbortSignal.timeout(3000),
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) {
      recordExternalNodeOutcome(baseUrl, 'piped', false, false, ms, res.status);
      throw new Error(`HTTP ${res.status}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (await res.json()) as any;
    const vList = Array.isArray(d?.videoStreams) ? d.videoStreams : [];
    const aList = Array.isArray(d?.audioStreams) ? d.audioStreams : [];
    const hlsUrl = typeof d?.hls === 'string' && d.hls ? d.hls : undefined;
    if (!d?.title && !vList.length && !aList.length && !hlsUrl) throw new Error('Empty Piped response');
    const hasStreams = vList.length > 0 || aList.length > 0 || Boolean(hlsUrl);
    recordExternalNodeOutcome(baseUrl, 'piped', true, hasStreams, ms, res.status);

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

    const recommendedVideos: RecommendedVideo[] = (Array.isArray(d.relatedStreams) ? d.relatedStreams : [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((r: any) => typeof r?.url === 'string' && r.url.includes('v='))
      .slice(0, 20)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any): RecommendedVideo => {
        const rid = String(r.url).split('v=')[1]?.split('&')[0] || '';
        return {
          videoId: rid,
          title: String(r.title || 'Untitled Video'),
          videoThumbnails: buildThumbnails(rid),
          author: String(r.uploaderName || 'YouTube Creator'),
          authorId: typeof r.uploaderUrl === 'string' ? r.uploaderUrl.split('/').pop() || '' : '',
          lengthSeconds: Number(r.duration || 0),
          viewCountText: formatViewsLabel(Number(r.views || 0)),
          viewCount: Number(r.views || 0),
        };
      })
      .filter((r: RecommendedVideo) => /^[a-zA-Z0-9_-]{6,20}$/.test(r.videoId) && r.videoId !== videoId);

    return {
      title: d.title ? String(d.title) : undefined,
      author: d.uploader ? String(d.uploader) : undefined,
      authorId: typeof d.uploaderUrl === 'string' ? d.uploaderUrl.split('/').pop() || '' : undefined,
      description: d.description ? String(d.description) : undefined,
      viewCount: typeof d.views === 'number' ? d.views : undefined,
      lengthSeconds: typeof d.duration === 'number' ? d.duration : undefined,
      publishedText: d.uploadDate ? String(d.uploadDate) : undefined,
      authorThumbnails: d.uploaderAvatar
        ? [{ url: proxyMediaUrl(String(d.uploaderAvatar)), width: 88, height: 88 }]
        : undefined,
      recommendedVideos,
      adaptiveFormats,
      formatStreams,
      hlsManifestUrl: hlsUrl,
      directStreamAvailable: hasStreams,
      upstreamSource: `piped-proxy:${baseUrl.replace(/^https?:\/\//, '')}`,
    } as Partial<VideoResponse>;
  });

  try {
    return await Promise.any([...invTasks, ...pipedTasks]);
  } catch {
    return null;
  }
}

async function searchViaExternalProxy(q: string, type = 'video', sortBy = 'relevance'): Promise<SearchVideoItem[]> {
  const invCandidates = getRankedExternalCandidates(
    'invidious',
    FALLBACK_INVIDIOUS_HOSTS.slice(0, 6).map((h) => `https://${h}`),
  ).slice(0, 5);
  const pipedCandidates = getRankedExternalCandidates(
    'piped',
    CURATED_PIPED_NODES.slice(0, 5).map((p) => p.url),
  ).slice(0, 4);

  const tasks: Promise<SearchVideoItem[]>[] = [
    ...invCandidates.map(async (baseUrl) => {
      const res = await proxiedFetch(
        `${baseUrl}/api/v1/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}&sort_by=${encodeURIComponent(sortBy)}`,
        { headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] }, signal: AbortSignal.timeout(3000) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const arr = (await res.json()) as any[];
      if (!Array.isArray(arr) || arr.length === 0) throw new Error('empty');
      return arr
        .filter((item) => item?.videoId)
        .slice(0, 24)
        .map((item): SearchVideoItem => ({
          type: 'video',
          title: String(item.title || 'Untitled Video'),
          videoId: String(item.videoId),
          author: String(item.author || 'YouTube Creator'),
          authorId: String(item.authorId || ''),
          authorUrl: item.authorId ? `/channel/${item.authorId}` : '',
          authorVerified: Boolean(item.authorVerified),
          videoThumbnails: buildThumbnails(String(item.videoId)),
          description: String(item.description || ''),
          descriptionHtml: textToHtml(item.description || ''),
          viewCount: Number(item.viewCount || 0),
          viewCountText: String(item.viewCountText || formatViewsLabel(Number(item.viewCount || 0))),
          published: Number(item.published || Math.floor(Date.now() / 1000)),
          publishedText: String(item.publishedText || ''),
          lengthSeconds: Number(item.lengthSeconds || 0),
          liveNow: Boolean(item.liveNow),
          is4k: /\b(4k|8k|2160p|uhd|hdr)\b/i.test(String(item.title || '')),
          authorThumbnails: [],
        }));
    }),
    ...pipedCandidates.map(async (baseUrl) => {
      const res = await proxiedFetch(
        `${baseUrl}/search?q=${encodeURIComponent(q)}&filter=videos`,
        { headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] }, signal: AbortSignal.timeout(3000) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = (await res.json()) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: any[] = Array.isArray(d?.items) ? d.items : [];
      if (items.length === 0) throw new Error('empty');
      return items
        .filter((it) => typeof it?.url === 'string' && it.url.includes('v='))
        .slice(0, 24)
        .map((it): SearchVideoItem => {
          const vid = String(it.url).split('v=')[1]?.split('&')[0] || '';
          return {
            type: 'video',
            title: String(it.title || 'Untitled Video'),
            videoId: vid,
            author: String(it.uploaderName || 'YouTube Creator'),
            authorId: typeof it.uploaderUrl === 'string' ? it.uploaderUrl.split('/').pop() || '' : '',
            authorUrl: '',
            authorVerified: Boolean(it.uploaderVerified),
            videoThumbnails: buildThumbnails(vid),
            description: String(it.shortDescription || ''),
            descriptionHtml: textToHtml(it.shortDescription || ''),
            viewCount: Number(it.views || 0),
            viewCountText: formatViewsLabel(Number(it.views || 0)),
            published: Math.floor(Date.now() / 1000),
            publishedText: String(it.uploadedDate || ''),
            lengthSeconds: Number(it.duration || 0),
            liveNow: Number(it.duration) <= 0,
            is4k: /\b(4k|8k|2160p|uhd|hdr)\b/i.test(String(it.title || '')),
            authorThumbnails: it.uploaderAvatar
              ? [{ url: proxyMediaUrl(String(it.uploaderAvatar)), width: 68, height: 68 }]
              : [],
          };
        })
        .filter((x) => /^[a-zA-Z0-9_-]{6,20}$/.test(x.videoId));
    }),
  ];

  try {
    return await Promise.any(tasks);
  } catch {
    return [];
  }
}

async function fetchCommentsViaExternalProxy(videoId: string): Promise<CommentsResponse | null> {
  const invCandidates = getRankedExternalCandidates(
    'invidious',
    FALLBACK_INVIDIOUS_HOSTS.slice(0, 5).map((h) => `https://${h}`),
  ).slice(0, 4);
  const pipedCandidates = getRankedExternalCandidates(
    'piped',
    CURATED_PIPED_NODES.slice(0, 4).map((p) => p.url),
  ).slice(0, 3);

  try {
    return await Promise.any([
      ...invCandidates.map(async (baseUrl): Promise<CommentsResponse> => {
        const res = await proxiedFetch(`${baseUrl}/api/v1/comments/${encodeURIComponent(videoId)}`, {
          headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (await res.json()) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list: CommentItem[] = (Array.isArray(d?.comments) ? d.comments : []).map((c: any, idx: number) => ({
          author: String(c.author || 'Anonymous'),
          authorThumbnails: c.authorThumbnails?.[0]?.url
            ? [{ url: proxyMediaUrl(String(c.authorThumbnails[0].url)), width: 48, height: 48 }]
            : [],
          authorId: String(c.authorId || ''),
          authorUrl: c.authorId ? `/channel/${c.authorId}` : '',
          isEdited: Boolean(c.isEdited),
          content: String(c.content || ''),
          contentHtml: textToHtml(c.content || ''),
          published: Number(c.published || Math.floor(Date.now() / 1000)),
          publishedText: String(c.publishedText || ''),
          likeCount: Number(c.likeCount || 0),
          commentId: String(c.commentId || `${videoId}_inv_${idx}`),
          authorIsChannelOwner: Boolean(c.authorIsChannelOwner),
        }));
        if (!list.length) throw new Error('empty');
        return { commentCount: Number(d.commentCount || list.length), videoId, comments: list };
      }),
      ...pipedCandidates.map(async (baseUrl): Promise<CommentsResponse> => {
        const res = await proxiedFetch(`${baseUrl}/comments/${encodeURIComponent(videoId)}`, {
          headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (await res.json()) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list: CommentItem[] = (Array.isArray(d?.comments) ? d.comments : []).map((c: any, idx: number) => ({
          author: String(c.author || 'Anonymous'),
          authorThumbnails: c.thumbnail
            ? [{ url: proxyMediaUrl(String(c.thumbnail)), width: 48, height: 48 }]
            : [],
          authorId: typeof c.commentorUrl === 'string' ? c.commentorUrl.split('/').pop() || '' : '',
          authorUrl: '',
          isEdited: false,
          content: String(c.commentText || ''),
          contentHtml: textToHtml(c.commentText || ''),
          published: Math.floor(Date.now() / 1000),
          publishedText: String(c.commentedTime || ''),
          likeCount: Number(c.likeCount || 0),
          commentId: String(c.commentId || `${videoId}_pip_${idx}`),
          authorIsChannelOwner: Boolean(c.hearted),
        }));
        if (!list.length) throw new Error('empty');
        return { commentCount: list.length, videoId, comments: list };
      }),
    ]);
  } catch {
    return null;
  }
}

async function fetchChannelViaExternalProxy(channelId: string): Promise<ChannelResponse | null> {
  const invCandidates = getRankedExternalCandidates(
    'invidious',
    FALLBACK_INVIDIOUS_HOSTS.slice(0, 5).map((h) => `https://${h}`),
  ).slice(0, 4);
  try {
    return await Promise.any(
      invCandidates.map(async (baseUrl): Promise<ChannelResponse> => {
        const res = await proxiedFetch(`${baseUrl}/api/v1/channels/${encodeURIComponent(channelId)}`, {
          headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
          signal: AbortSignal.timeout(3200),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ch = (await res.json()) as any;
        if (!ch?.author) throw new Error('empty');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const latestVideos: SearchVideoItem[] = (Array.isArray(ch.latestVideos) ? ch.latestVideos : []).slice(0, 24).map((v: any) => ({
          type: 'video',
          title: String(v.title || 'Untitled Video'),
          videoId: String(v.videoId || ''),
          author: String(ch.author),
          authorId: channelId,
          authorUrl: `/channel/${channelId}`,
          authorVerified: Boolean(ch.authorVerified),
          videoThumbnails: buildThumbnails(String(v.videoId || '')),
          description: '',
          descriptionHtml: '',
          viewCount: Number(v.viewCount || 0),
          viewCountText: String(v.viewCountText || formatViewsLabel(Number(v.viewCount || 0))),
          published: Number(v.published || Math.floor(Date.now() / 1000)),
          publishedText: String(v.publishedText || ''),
          lengthSeconds: Number(v.lengthSeconds || 0),
          liveNow: Boolean(v.liveNow),
          is4k: /\b(4k|8k|2160p|uhd|hdr)\b/i.test(String(v.title || '')),
          authorThumbnails: [],
        }));
        return {
          author: String(ch.author),
          authorId: channelId,
          authorUrl: `/channel/${channelId}`,
          authorBanners: ch.authorBanners?.[0]?.url
            ? [{ url: proxyMediaUrl(String(ch.authorBanners[0].url)), width: 1280, height: 240 }]
            : [],
          authorThumbnails: ch.authorThumbnails?.[0]?.url
            ? [{ url: proxyMediaUrl(String(ch.authorThumbnails[0].url)), width: 176, height: 176 }]
            : [],
          subCount: Number(ch.subCount || 0),
          subCountText: String(ch.subCountText || ''),
          totalViews: Number(ch.totalViews || 0),
          joined: Number(ch.joined || 0),
          autoGenerated: false,
          isFamilyFriendly: Boolean(ch.isFamilyFriendly ?? true),
          description: String(ch.description || ''),
          descriptionHtml: textToHtml(ch.description || ''),
          latestVideos,
        };
      }),
    );
  } catch {
    return null;
  }
}

// Keep alias for compatibility with existing calls
async function raceInvidiousVideoNode(videoId: string): Promise<Partial<VideoResponse> | null> {
  return fetchVideoViaExternalProxy(videoId);
}

async function extractDirectInnertubeStreams(
  yt: Innertube,
  videoId: string,
): Promise<{
  adaptiveFormats: AdaptiveFormat[];
  formatStreams: FormatStream[];
  hlsManifestUrl?: string;
  source: string;
} | null> {
  const po = await getWebPoMinter().catch(() => null);
  const pot = po ? await po.minter.mintAsWebsafeString(videoId).catch(() => '') : '';

  const clientOrder = yt.session.logged_in
    ? (['TV', 'WEB', 'IOS', 'ANDROID', 'ANDROID_VR'] as const)
    : (['WEB', 'IOS', 'TV', 'ANDROID_VR', 'ANDROID', 'MWEB'] as const);

  let collectedAdaptive: AdaptiveFormat[] = [];
  let collectedFormats: FormatStream[] = [];
  let collectedHls = '';
  let sourceClient = '';

  for (const client of clientOrder) {
    try {
      const basic = await yt.getBasicInfo(videoId, { client });
      const rawAdaptive = basic.streaming_data?.adaptive_formats || [];
      const rawMuxed = basic.streaming_data?.formats || [];
      const hlsUrl = String(basic.streaming_data?.hls_manifest_url || '');
      if (hlsUrl && !collectedHls) {
        collectedHls = hlsUrl;
      }
      if (!rawAdaptive.length && !rawMuxed.length && !hlsUrl) continue;

      const adaptiveFormats: AdaptiveFormat[] = [];
      for (const f of rawAdaptive) {
        try {
          let deciphered = await f.decipher(yt.session.player);
          if (deciphered && pot && !deciphered.includes('pot=')) {
            deciphered += `&pot=${encodeURIComponent(pot)}`;
          }
          if (!deciphered) continue;
          const mime = String(f.mime_type || '');
          const container = mime.includes('webm') ? 'webm' : mime.includes('mp4') ? 'mp4' : 'webm';
          const codecMatch = mime.match(/codecs="([^"]+)"/);
          adaptiveFormats.push({
            bitrate: String(f.bitrate || '0'),
            url: deciphered,
            proxyUrl: `/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(String(f.itag))}`,
            itag: String(f.itag),
            type: mime,
            container,
            encoding: codecMatch ? codecMatch[1] : container,
            qualityLabel: String(f.quality_label || (f.has_audio && !f.has_video ? 'Audio' : '')),
            resolution: String(f.quality_label || ''),
            fps: typeof f.fps === 'number' ? f.fps : undefined,
            audioQuality: f.audio_quality,
            audioChannels: f.audio_channels,
          });
        } catch {
          // skip single undecipherable format
        }
      }

      const formatStreams: FormatStream[] = [];
      for (const f of rawMuxed) {
        try {
          let deciphered = await f.decipher(yt.session.player);
          if (deciphered && pot && !deciphered.includes('pot=')) {
            deciphered += `&pot=${encodeURIComponent(pot)}`;
          }
          if (!deciphered) continue;
          const mime = String(f.mime_type || '');
          const container = mime.includes('mp4') ? 'mp4' : 'webm';
          formatStreams.push({
            url: deciphered,
            proxyUrl: `/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(String(f.itag))}`,
            itag: String(f.itag),
            type: mime,
            quality: String(f.quality || f.quality_label || ''),
            container,
            encoding: 'h264',
            qualityLabel: String(f.quality_label || ''),
            resolution: String(f.quality_label || ''),
          });
        } catch {
          // skip
        }
      }

      if ((adaptiveFormats.length > 0 || formatStreams.length > 0) && !collectedAdaptive.length) {
        collectedAdaptive = adaptiveFormats;
        collectedFormats = formatStreams;
        sourceClient = `innertube-${client.toLowerCase()}`;
      }
      if (collectedAdaptive.length > 0 && collectedHls) break;
      // Continue only through IOS if HLS manifest hasn't been gathered yet
      if (collectedAdaptive.length > 0 && collectedFormats.length > 0 && client === 'IOS') {
        break;
      }
    } catch {
      // try next client
    }
  }

  if (collectedAdaptive.length > 0 || collectedFormats.length > 0 || collectedHls) {
    return {
      adaptiveFormats: collectedAdaptive,
      formatStreams: collectedFormats,
      hlsManifestUrl: collectedHls || undefined,
      source: sourceClient || 'innertube-hls',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Anubis PoW Solver + Companion & Multi-Source Guaranteed Stream Extractor
// ---------------------------------------------------------------------------
const COMPANION_BASES = [
  'https://invid-api.poketube.fun/companion',
];
const POKETUBE_BASE = 'https://poketube.fun';
const ANUBIS_UA = PRIVACY_USER_AGENTS[0];

const anubisCookieCache = new Map<string, { cookie: string; solvedAt: number }>();
const anubisSolveInFlight = new Map<string, Promise<string>>();

async function solveAnubisForOrigin(targetUrl: string): Promise<string> {
  const origin = new URL(targetUrl).origin;
  const cached = anubisCookieCache.get(origin);
  if (cached && Date.now() - cached.solvedAt < 6 * 3600_000) {
    return cached.cookie;
  }
  const existingPromise = anubisSolveInFlight.get(origin);
  if (existingPromise) return existingPromise;

  const job = (async () => {
    try {
      const r1 = await proxiedFetch(targetUrl, {
        headers: { 'User-Agent': ANUBIS_UA },
        signal: AbortSignal.timeout(6000),
      });
      const setCookies1 = (r1.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() || [];
      const html = await r1.text();
      const chalMatch = html.match(/<script id="anubis_challenge"[^>]*>([\s\S]*?)<\/script>/);
      if (!chalMatch) {
        const directCookie = setCookies1.map((c) => c.split(';')[0]).join('; ');
        if (directCookie) anubisCookieCache.set(origin, { cookie: directCookie, solvedAt: Date.now() });
        return directCookie;
      }
      const chal = JSON.parse(chalMatch[1]);
      const diff = Number(chal?.rules?.difficulty ?? 4);
      const data = String(chal?.challenge?.randomData || '');
      const id = String(chal?.challenge?.id || '');
      if (!data) return '';

      const prefix = '0'.repeat(Math.min(6, Math.max(1, diff)));
      const t0 = Date.now();
      let nonce = 0;
      let hash = '';
      while (nonce < 2_000_000) {
        hash = crypto.createHash('sha256').update(data + nonce).digest('hex');
        if (hash.startsWith(prefix)) break;
        nonce++;
      }
      const elapsed = Math.max(1, Date.now() - t0);
      const initCookie = setCookies1.map((c) => c.split(';')[0]).join('; ');
      const passUrl =
        `${origin}/.within.website/x/cmd/anubis/api/pass-challenge` +
        `?id=${encodeURIComponent(id)}&response=${encodeURIComponent(hash)}&nonce=${nonce}` +
        `&redir=${encodeURIComponent(targetUrl)}&elapsedTime=${elapsed}`;

      const r2 = await proxiedFetch(passUrl, {
        headers: { 'User-Agent': ANUBIS_UA, ...(initCookie ? { Cookie: initCookie } : {}) },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      const setCookies2 = (r2.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() || [];
      const merged = [...setCookies1, ...setCookies2]
        .map((c) => c.split(';')[0])
        .filter(Boolean)
        .join('; ');
      if (merged) {
        anubisCookieCache.set(origin, { cookie: merged, solvedAt: Date.now() });
      }
      return merged;
    } catch {
      return '';
    } finally {
      anubisSolveInFlight.delete(origin);
    }
  })();

  anubisSolveInFlight.set(origin, job);
  return job;
}

async function fetchWithAnubis(targetUrl: string, init: RequestInit = {}): Promise<Response> {
  const origin = new URL(targetUrl).origin;
  const cached = anubisCookieCache.get(origin);
  const headersObj = new Headers(init.headers as HeadersInit | undefined);
  if (!headersObj.has('User-Agent')) headersObj.set('User-Agent', ANUBIS_UA);
  if (cached?.cookie && !headersObj.has('Cookie')) {
    headersObj.set('Cookie', cached.cookie);
  }

  let res = await proxiedFetch(targetUrl, { ...init, headers: headersObj });
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html') && res.status === 200) {
    const cloneTxt = await res.clone().text().catch(() => '');
    if (cloneTxt.includes('anubis_challenge')) {
      anubisCookieCache.delete(origin);
      const freshCookie = await solveAnubisForOrigin(targetUrl);
      if (freshCookie) {
        headersObj.set('Cookie', freshCookie);
        res = await proxiedFetch(targetUrl, { ...init, headers: headersObj });
      }
    }
  }
  return res;
}

function extractBalancedJsonArray(html: string, key: string): unknown[] {
  const idx = html.indexOf(`"${key}":`);
  if (idx < 0) return [];
  const scanFrom = html.indexOf('[', idx);
  if (scanFrom < 0) return [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let endIdx = -1;
  for (let i = scanFrom; i < html.length; i++) {
    const ch = html[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\' && inStr) {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (!inStr) {
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }
  }
  if (endIdx <= scanFrom) return [];
  try {
    const parsed = JSON.parse(html.slice(scanFrom, endIdx));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

interface ItagMeta {
  itag: string;
  mime: string;
  container: string;
  encoding: string;
  qualityLabel: string;
  fps?: number;
  isProgressive?: boolean;
  isAudio?: boolean;
  bitrate: string;
}

const ITAG_CATALOG: Record<string, ItagMeta> = {
  '18': { itag: '18', mime: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', container: 'mp4', encoding: 'h264+aac', qualityLabel: '360p', fps: 30, isProgressive: true, bitrate: '600000' },
  '22': { itag: '22', mime: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"', container: 'mp4', encoding: 'h264+aac', qualityLabel: '720p', fps: 30, isProgressive: true, bitrate: '2200000' },
  '140': { itag: '140', mime: 'audio/mp4; codecs="mp4a.40.2"', container: 'mp4', encoding: 'mp4a.40.2', qualityLabel: 'Audio 128k', isAudio: true, bitrate: '130000' },
  '251': { itag: '251', mime: 'audio/webm; codecs="opus"', container: 'webm', encoding: 'opus', qualityLabel: 'Audio Opus', isAudio: true, bitrate: '160000' },
  '258': { itag: '258', mime: 'audio/mp4; codecs="mp4a.40.2"', container: 'mp4', encoding: 'mp4a.40.2', qualityLabel: 'Audio 384k', isAudio: true, bitrate: '384000' },
  '134': { itag: '134', mime: 'video/mp4; codecs="avc1.4D401E"', container: 'mp4', encoding: 'avc1.4D401E', qualityLabel: '360p', fps: 30, bitrate: '650000' },
  '135': { itag: '135', mime: 'video/mp4; codecs="avc1.4D401F"', container: 'mp4', encoding: 'avc1.4D401F', qualityLabel: '480p', fps: 30, bitrate: '1100000' },
  '136': { itag: '136', mime: 'video/mp4; codecs="avc1.4D401F"', container: 'mp4', encoding: 'avc1.4D401F', qualityLabel: '720p', fps: 30, bitrate: '2500000' },
  '298': { itag: '298', mime: 'video/mp4; codecs="avc1.4D4020"', container: 'mp4', encoding: 'avc1.4D4020', qualityLabel: '720p60', fps: 60, bitrate: '4200000' },
  '137': { itag: '137', mime: 'video/mp4; codecs="avc1.640028"', container: 'mp4', encoding: 'avc1.640028', qualityLabel: '1080p', fps: 30, bitrate: '4500000' },
  '299': { itag: '299', mime: 'video/mp4; codecs="avc1.64002A"', container: 'mp4', encoding: 'avc1.64002A', qualityLabel: '1080p60', fps: 60, bitrate: '6800000' },
  '247': { itag: '247', mime: 'video/webm; codecs="vp9"', container: 'webm', encoding: 'vp9', qualityLabel: '720p', fps: 30, bitrate: '1800000' },
  '302': { itag: '302', mime: 'video/webm; codecs="vp9"', container: 'webm', encoding: 'vp9', qualityLabel: '720p60', fps: 60, bitrate: '2800000' },
  '248': { itag: '248', mime: 'video/webm; codecs="vp9"', container: 'webm', encoding: 'vp9', qualityLabel: '1080p', fps: 30, bitrate: '3200000' },
  '303': { itag: '303', mime: 'video/webm; codecs="vp9"', container: 'webm', encoding: 'vp9', qualityLabel: '1080p60', fps: 60, bitrate: '4600000' },
  '308': { itag: '308', mime: 'video/webm; codecs="vp9"', container: 'webm', encoding: 'vp9', qualityLabel: '1440p60', fps: 60, bitrate: '13000000' },
  '315': { itag: '315', mime: 'video/webm; codecs="vp9"', container: 'webm', encoding: 'vp9', qualityLabel: '2160p60', fps: 60, bitrate: '26000000' },
  '313': { itag: '313', mime: 'video/webm; codecs="vp9"', container: 'webm', encoding: 'vp9', qualityLabel: '2160p', fps: 30, bitrate: '18000000' },
  '401': { itag: '401', mime: 'video/mp4; codecs="av01.0.13M.08"', container: 'mp4', encoding: 'av01.0.13M.08', qualityLabel: '2160p60', fps: 60, bitrate: '17000000' },
};

function companionStreamUrl(videoId: string, itag: string): string {
  return `${COMPANION_BASES[0]}/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(itag)}&local=true`;
}

function poketubeDownloadUrl(videoId: string, itag: string): string {
  return `${POKETUBE_BASE}/api/video/download?v=${encodeURIComponent(videoId)}&q=${encodeURIComponent(itag)}`;
}

async function probeCompanionItags(videoId: string): Promise<{
  adaptiveFormats: AdaptiveFormat[];
  formatStreams: FormatStream[];
}> {
  const probeItags = ['18', '140', '251', '136', '298', '137', '299', '302', '303', '248', '247', '308', '315'];
  const results = await Promise.allSettled(
    probeItags.map(async (itag) => {
      const target = companionStreamUrl(videoId, itag);
      const r = await proxiedFetch(target, {
        headers: { 'User-Agent': ANUBIS_UA, Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(4500),
      });
      if (!r.ok) return null;
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/plain') || ct.includes('text/html')) return null;
      const cr = r.headers.get('content-range') || '';
      const totalBytes = cr.includes('/') ? cr.split('/')[1] : '';
      return { itag, target, ct, clen: totalBytes && totalBytes !== '*' ? totalBytes : undefined };
    }),
  );

  const adaptiveFormats: AdaptiveFormat[] = [];
  const formatStreams: FormatStream[] = [];
  for (const res of results) {
    if (res.status !== 'fulfilled' || !res.value) continue;
    const { itag, target, clen } = res.value;
    const meta = ITAG_CATALOG[itag];
    if (!meta) continue;
    if (meta.isProgressive) {
      formatStreams.push({
        url: target,
        proxyUrl: `/api/v1/stream/googlevideo/${encodeURIComponent(videoId)}?itag=${encodeURIComponent(itag)}`,
        itag,
        type: meta.mime,
        quality: meta.qualityLabel,
        bitrate: meta.bitrate,
        container: meta.container,
        encoding: meta.encoding,
        qualityLabel: meta.qualityLabel,
        resolution: meta.qualityLabel,
      });
    } else {
      adaptiveFormats.push({
        bitrate: meta.bitrate,
        url: target,
        proxyUrl: `/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(itag)}`,
        itag,
        type: meta.mime,
        clen,
        container: meta.container,
        encoding: meta.encoding,
        qualityLabel: meta.qualityLabel,
        resolution: meta.isAudio ? '' : meta.qualityLabel,
        fps: meta.fps,
        audioQuality: meta.isAudio ? 'AUDIO_QUALITY_MEDIUM' : undefined,
      });
    }
  }
  return { adaptiveFormats, formatStreams };
}

async function extractCompanionAndPoketubeStreams(videoId: string): Promise<Partial<VideoResponse> | null> {
  const [pokeWatchRes, dashMpdRes, probeRes] = await Promise.allSettled([
    (async () => {
      const target = `${POKETUBE_BASE}/watch?v=${encodeURIComponent(videoId)}`;
      const r = await fetchWithAnubis(target, { signal: AbortSignal.timeout(7000) });
      if (!r.ok) return null;
      const html = await r.text();
      if (html.includes('anubis_challenge')) return null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawAdp = extractBalancedJsonArray(html, 'adaptiveFormats') as any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawFmt = extractBalancedJsonArray(html, 'formatStreams') as any[];
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      const cleanTitle = titleMatch ? titleMatch[1].replace(/\s*-\s*PokeTube.*$/i, '').trim() : '';

      const adaptiveFormats: AdaptiveFormat[] = [];
      for (const f of rawAdp) {
        const itag = String(f?.itag || '').trim();
        if (!itag) continue;
        const mime = String(f?.type || ITAG_CATALOG[itag]?.mime || 'video/mp4');
        const isAudio = mime.startsWith('audio/');
        const container = mime.includes('webm') ? 'webm' : 'mp4';
        const codecMatch = mime.match(/codecs="([^"]+)"/);
        adaptiveFormats.push({
          bitrate: String(f?.bitrate || ITAG_CATALOG[itag]?.bitrate || '0'),
          url: companionStreamUrl(videoId, itag),
          proxyUrl: `/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(itag)}`,
          itag,
          type: mime,
          clen: f?.clen ? String(f.clen) : undefined,
          container,
          encoding: codecMatch ? codecMatch[1] : String(f?.encoding || container),
          qualityLabel: String(f?.qualityLabel || ITAG_CATALOG[itag]?.qualityLabel || (isAudio ? 'Audio' : '')),
          resolution: String(f?.qualityLabel || ITAG_CATALOG[itag]?.qualityLabel || ''),
          fps: typeof f?.fps === 'number' ? f.fps : ITAG_CATALOG[itag]?.fps,
          audioQuality: isAudio ? String(f?.audioQuality || 'AUDIO_QUALITY_MEDIUM') : undefined,
        });
      }

      const formatStreams: FormatStream[] = [];
      for (const f of rawFmt) {
        const itag = String(f?.itag || '').trim();
        if (!itag) continue;
        const mime = String(f?.type || ITAG_CATALOG[itag]?.mime || 'video/mp4');
        formatStreams.push({
          url: companionStreamUrl(videoId, itag),
          proxyUrl: `/api/v1/stream/googlevideo/${encodeURIComponent(videoId)}?itag=${encodeURIComponent(itag)}`,
          itag,
          type: mime,
          quality: String(f?.quality || f?.qualityLabel || '360p'),
          container: mime.includes('webm') ? 'webm' : 'mp4',
          encoding: String(f?.encoding || 'h264+aac'),
          qualityLabel: String(f?.qualityLabel || f?.quality || '360p'),
          resolution: String(f?.qualityLabel || f?.quality || '360p'),
        });
      }

      return { title: cleanTitle || undefined, adaptiveFormats, formatStreams };
    })(),

    (async () => {
      const r = await proxiedFetch(`${COMPANION_BASES[0]}/api/manifest/dash/id/${encodeURIComponent(videoId)}`, {
        headers: { 'User-Agent': ANUBIS_UA },
        signal: AbortSignal.timeout(4500),
      });
      if (!r.ok) return null;
      const xml = await r.text();
      const adaptiveFormats: AdaptiveFormat[] = [];
      const adaptRegex = /<AdaptationSet\s+([^>]+)>([\s\S]*?)<\/AdaptationSet>/g;
      let am: RegExpExecArray | null;
      while ((am = adaptRegex.exec(xml)) !== null) {
        const asetAttrs = am[1];
        const asetBody = am[2];
        const mimeBase = asetAttrs.match(/mimeType="([^"]+)"/)?.[1] || 'video/mp4';
        const isAudio = mimeBase.startsWith('audio/');
        const repRegex = /<Representation\s+([^>]+)>([\s\S]*?)<\/Representation>/g;
        let rm: RegExpExecArray | null;
        while ((rm = repRegex.exec(asetBody)) !== null) {
          const rattrs = rm[1];
          const rawId = rattrs.match(/\bid="([^"]+)"/)?.[1] || '';
          const itag = rawId.replace(/[^0-9]/g, '') || rawId;
          if (!itag) continue;
          const bw = rattrs.match(/\bbandwidth="([^"]+)"/)?.[1] || '0';
          const codecs = rattrs.match(/\bcodecs="([^"]+)"/)?.[1] || '';
          const height = rattrs.match(/\bheight="([^"]+)"/)?.[1];
          const fps = Number(rattrs.match(/\bframeRate="([^"]+)"/)?.[1] || 0) || undefined;
          const qLabel = isAudio
            ? `Audio ${Math.round(Number(bw) / 1000)}k`
            : height
              ? `${height}p${fps && fps >= 50 ? fps : ''}`
              : ITAG_CATALOG[itag]?.qualityLabel || '';
          adaptiveFormats.push({
            bitrate: bw,
            url: companionStreamUrl(videoId, itag),
            proxyUrl: `/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(itag)}`,
            itag,
            type: codecs ? `${mimeBase}; codecs="${codecs}"` : mimeBase,
            container: mimeBase.includes('webm') ? 'webm' : 'mp4',
            encoding: codecs || (mimeBase.includes('webm') ? 'vp9' : 'avc1'),
            qualityLabel: qLabel,
            resolution: isAudio ? '' : qLabel,
            fps,
            audioQuality: isAudio ? 'AUDIO_QUALITY_MEDIUM' : undefined,
          });
        }
      }
      return { adaptiveFormats };
    })(),

    probeCompanionItags(videoId),
  ]);

  const adpMap = new Map<string, AdaptiveFormat>();
  const fmtMap = new Map<string, FormatStream>();

  const pokeData = pokeWatchRes.status === 'fulfilled' ? pokeWatchRes.value : null;
  const mpdData = dashMpdRes.status === 'fulfilled' ? dashMpdRes.value : null;
  const probeData = probeRes.status === 'fulfilled' ? probeRes.value : null;

  for (const f of [...(probeData?.adaptiveFormats || []), ...(mpdData?.adaptiveFormats || []), ...(pokeData?.adaptiveFormats || [])]) {
    if (!f.itag) continue;
    const prev = adpMap.get(f.itag);
    adpMap.set(f.itag, { ...prev, ...f, clen: f.clen || prev?.clen });
  }
  for (const f of [...(probeData?.formatStreams || []), ...(pokeData?.formatStreams || [])]) {
    if (!f.itag) continue;
    fmtMap.set(f.itag, f);
  }

  // Ensure itag 18 progressive stream is always present if any video/audio exists and 18 wasn't dropped
  if (fmtMap.size === 0 && (adpMap.size > 0)) {
    const meta18 = ITAG_CATALOG['18'];
    fmtMap.set('18', {
      url: companionStreamUrl(videoId, '18'),
      proxyUrl: `/api/v1/stream/googlevideo/${encodeURIComponent(videoId)}?itag=18`,
      itag: '18',
      type: meta18.mime,
      quality: '360p',
      bitrate: meta18.bitrate,
      container: 'mp4',
      encoding: 'h264+aac',
      qualityLabel: '360p',
      resolution: '360p',
    });
  }

  const adaptiveFormats = [...adpMap.values()];
  const formatStreams = [...fmtMap.values()];
  if (adaptiveFormats.length === 0 && formatStreams.length === 0) {
    return null;
  }

  return {
    title: pokeData?.title,
    adaptiveFormats,
    formatStreams,
    directStreamAvailable: true,
    upstreamSource: pokeData?.adaptiveFormats?.length ? 'kuro-companion+poketube' : 'kuro-companion-edge',
  };
}

async function fetchUpstreamMediaWithFailover(
  videoId: string,
  itag: string,
  primaryUrl: string,
  rangeHeader?: string,
): Promise<Response> {
  const candidates: string[] = [];
  if (primaryUrl) candidates.push(primaryUrl);
  const compUrl = companionStreamUrl(videoId, itag);
  if (!candidates.includes(compUrl)) candidates.push(compUrl);
  const pokeUrl = poketubeDownloadUrl(videoId, itag);
  if (!candidates.includes(pokeUrl)) candidates.push(pokeUrl);

  let lastRes: Response | null = null;
  for (const target of candidates) {
    try {
      const headers = buildMaskedUpstreamHeaders(rangeHeader, target);
      const r = target.includes('poketube.fun/api/')
        ? await fetchWithAnubis(target, { headers, signal: AbortSignal.timeout(18000) })
        : await proxiedFetch(target, { headers, signal: AbortSignal.timeout(18000) });

      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (r.ok && !ct.includes('text/html') && !ct.includes('text/plain')) {
        return r;
      }
      lastRes = r;
    } catch {
      // try next upstream candidate
    }
  }
  if (lastRes) return lastRes;
  throw new Error('上流メディアストリームの取得に失敗しました');
}

// ---------------------------------------------------------------------------
// Core Video Extractor (Companion+PokeTube + InnerTube + External Proxy + oEmbed)
// ---------------------------------------------------------------------------
async function fetchVideoFull(videoId: string): Promise<VideoResponse> {
  const ytPromiseLocal = getYt().catch(() => null);

  const [infoResult, oembedResult, externalProxyResult, directStreamResult, companionResult] = await Promise.allSettled([
    ytPromiseLocal.then((yt) => (yt ? yt.getInfo(videoId) : null)),
    proxiedFetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`,
      { headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] }, signal: AbortSignal.timeout(2800) },
    ).then((r) => (r.ok ? r.json() : null)),
    fetchVideoViaExternalProxy(videoId),
    ytPromiseLocal.then((yt) => (yt ? extractDirectInnertubeStreams(yt, videoId) : null)),
    extractCompanionAndPoketubeStreams(videoId),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info: any = infoResult.status === 'fulfilled' ? infoResult.value : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oembed: any = oembedResult.status === 'fulfilled' ? oembedResult.value : null;
  const raceData = externalProxyResult.status === 'fulfilled' ? externalProxyResult.value : null;
  const directData = directStreamResult.status === 'fulfilled' ? directStreamResult.value : null;
  const companionData = companionResult.status === 'fulfilled' ? companionResult.value : null;

  const title =
    info?.primary_info?.title?.text ||
    info?.basic_info?.title ||
    oembed?.title ||
    companionData?.title ||
    raceData?.title ||
    `Video ${videoId}`;

  const author =
    info?.secondary_info?.owner?.author?.name ||
    info?.basic_info?.author ||
    oembed?.author_name ||
    raceData?.author ||
    'YouTube Creator';

  const authorId =
    info?.secondary_info?.owner?.author?.id ||
    info?.basic_info?.channel_id ||
    raceData?.authorId ||
    '';

  const authorThumb =
    info?.secondary_info?.owner?.author?.thumbnails?.[0]?.url || '';

  const subCountText =
    info?.secondary_info?.owner?.subscriber_count?.text || '';

  const viewText =
    info?.primary_info?.view_count?.view_count?.text ||
    info?.primary_info?.view_count?.short_view_count?.text ||
    '';

  const viewCount =
    info?.basic_info?.view_count ||
    raceData?.viewCount ||
    parseViewCount(viewText);

  const publishedText =
    info?.primary_info?.published?.text ||
    raceData?.publishedText ||
    '';

  const description =
    info?.secondary_info?.description?.text ||
    info?.basic_info?.short_description ||
    raceData?.description ||
    '';

  // Extract recommended videos from watch_next_feed (LockupView) OR external proxy node
  const recommendedRaw = Array.isArray(info?.watch_next_feed) ? info.watch_next_feed : [];
  const recommendedVideos: RecommendedVideo[] = [];
  const seenRecIds = new Set<string>([videoId]);
  for (const item of recommendedRaw) {
    const mapped = mapRawVideoItem(item);
    if (mapped && !seenRecIds.has(mapped.videoId)) {
      seenRecIds.add(mapped.videoId);
      recommendedVideos.push({
        videoId: mapped.videoId,
        title: mapped.title,
        videoThumbnails: mapped.videoThumbnails,
        author: mapped.author,
        authorId: mapped.authorId,
        lengthSeconds: mapped.lengthSeconds,
        viewCountText: mapped.viewCountText,
        viewCount: mapped.viewCount,
      });
    }
    if (recommendedVideos.length >= 20) break;
  }

  for (const r of raceData?.recommendedVideos || []) {
    if (!seenRecIds.has(r.videoId)) {
      seenRecIds.add(r.videoId);
      recommendedVideos.push(r);
    }
    if (recommendedVideos.length >= 20) break;
  }

  // Fallback search for related videos via proxy/InnerTube if fewer than 8
  if (recommendedVideos.length < 8) {
    const fallbackQuery =
      (title && !title.startsWith('Video ') ? title.slice(0, 60) : '') ||
      (author && author !== 'YouTube Creator' ? author : '4K HDR Japan');
    const yt = await ytPromiseLocal;
    const relSearch = yt
      ? await yt.search(fallbackQuery, { type: 'video', prioritize: 'relevance' }).catch(() => null)
      : null;
    for (const v of relSearch?.videos || []) {
      const mapped = mapRawVideoItem(v);
      if (mapped && !seenRecIds.has(mapped.videoId)) {
        seenRecIds.add(mapped.videoId);
        recommendedVideos.push({
          videoId: mapped.videoId,
          title: mapped.title,
          videoThumbnails: mapped.videoThumbnails,
          author: mapped.author,
          authorId: mapped.authorId,
          lengthSeconds: mapped.lengthSeconds,
          viewCountText: mapped.viewCountText,
          viewCount: mapped.viewCount,
        });
      }
      if (recommendedVideos.length >= 20) break;
    }
    if (recommendedVideos.length < 8) {
      const proxyRel = await searchViaExternalProxy(fallbackQuery, 'video', 'relevance');
      for (const mapped of proxyRel) {
        if (!seenRecIds.has(mapped.videoId)) {
          seenRecIds.add(mapped.videoId);
          recommendedVideos.push({
            videoId: mapped.videoId,
            title: mapped.title,
            videoThumbnails: mapped.videoThumbnails,
            author: mapped.author,
            authorId: mapped.authorId,
            lengthSeconds: mapped.lengthSeconds,
            viewCountText: mapped.viewCountText,
            viewCount: mapped.viewCount,
          });
        }
        if (recommendedVideos.length >= 20) break;
      }
    }
  }

  // Extract lengthSeconds if present in basic_info, external proxy, or search fallback
  let lengthSeconds = Number(info?.basic_info?.duration || raceData?.lengthSeconds || 0);
  if (!lengthSeconds && title) {
    const yt = await ytPromiseLocal;
    const searchLookup = yt ? await yt.search(videoId).catch(() => null) : null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matched = searchLookup?.videos?.find((v: any) => v?.id === videoId);
    if (matched) {
      const mapped = mapRawVideoItem(matched);
      if (mapped?.lengthSeconds) lengthSeconds = mapped.lengthSeconds;
    }
  }

  const adaptiveFormats: AdaptiveFormat[] =
    companionData?.adaptiveFormats?.length
      ? companionData.adaptiveFormats
      : directData?.adaptiveFormats?.length
        ? directData.adaptiveFormats
        : raceData?.adaptiveFormats?.length
          ? raceData.adaptiveFormats
          : [];

  const formatStreams: FormatStream[] =
    companionData?.formatStreams?.length
      ? companionData.formatStreams
      : directData?.formatStreams?.length
        ? directData.formatStreams
        : raceData?.formatStreams?.length
          ? raceData.formatStreams
          : [];

  // Cache stream URLs for /latest_version, /api/v1/stream/mux, /api/v1/stream/googlevideo, and /api/v1/download proxying
  for (const fmt of [...adaptiveFormats, ...formatStreams]) {
    if (fmt.url && fmt.itag) {
      cacheSet(`stream:${videoId}:${fmt.itag}`, { url: fmt.url, type: fmt.type }, 1_800_000, 'stream-url');
    }
  }

  const hlsManifestUrl = directData?.hlsManifestUrl || raceData?.hlsManifestUrl || undefined;
  const hasDirectStreams = adaptiveFormats.length > 0 || formatStreams.length > 0 || Boolean(hlsManifestUrl);
  const hlsProxyUrl = hlsManifestUrl
    ? `/api/v1/stream/hls-proxy?url=${encodeURIComponent(hlsManifestUrl)}`
    : (adaptiveFormats.length > 0 || formatStreams.length > 0) && FFMPEG_AVAILABLE
      ? `/api/v1/stream/hls-gen/${encodeURIComponent(videoId)}/index.m3u8`
      : undefined;

  const maxResFromAdaptive = adaptiveFormats.find((f) => /2160|4k/i.test(f.qualityLabel))
    ? '2160p60 4K'
    : adaptiveFormats.find((f) => /1440/i.test(f.qualityLabel))
      ? '1440p60 QHD'
      : adaptiveFormats.find((f) => /1080/i.test(f.qualityLabel))
        ? '1080p60 FHD'
        : formatStreams.find((f) => /720/i.test(f.qualityLabel))
          ? '720p HD'
          : /\b(8k|4320p)\b/i.test(title)
            ? '4320p 8K'
            : /\b(4k|2160p|uhd)\b/i.test(title)
              ? '2160p60 4K'
              : '1080p HD';

  const clientRelayStreams = [
    {
      label: 'Server 1 · 超高速Range MP4 (itag 18)',
      itag: '18',
      host: 'kuro-srv-1:3001',
      url: `/api/server/1/stream/${encodeURIComponent(videoId)}`,
    },
    {
      label: 'Server 2 · 高画質1080p/4K Mux MP4',
      itag: 'mux',
      host: 'kuro-srv-2:3002',
      url: `/api/server/2/stream/${encodeURIComponent(videoId)}`,
    },
    {
      label: 'Server 3 · Adaptive HLS (.m3u8)',
      itag: 'hls',
      host: 'kuro-srv-3:3003',
      url: `/api/server/3/stream/${encodeURIComponent(videoId)}`,
    },
    {
      label: 'Server 4 · 超安定 H.264/AAC MP4',
      itag: '18',
      host: 'kuro-srv-4:3004',
      url: `/api/server/4/stream/${encodeURIComponent(videoId)}`,
    },
    {
      label: 'Server 5 · 自律フォールバック統合',
      itag: 'auto',
      host: 'kuro-srv-5:3005',
      url: `/api/server/5/stream/${encodeURIComponent(videoId)}`,
    },
  ];

  const streamErrorReason = hasDirectStreams
    ? undefined
    : '外部プロキシ・クラスタで生ストリーム解決中、または一部制限動画です。下の「外部Invidious/Zernio自動復旧」や「正規 Edu再生 (youtubeeducation.com)」をお試しください。';

  const eduEmbed = buildEduEmbedConfig(
    videoId,
    title,
    author,
    Boolean(oembed?.html || info?.playability_status?.playable_in_embed !== false),
  );
  const defaultProgItag = formatStreams[0]?.itag || '18';
  const googlevideoProxyUrl =
    formatStreams.length > 0 || adaptiveFormats.length > 0
      ? `/api/v1/stream/googlevideo/${encodeURIComponent(videoId)}?itag=${encodeURIComponent(defaultProgItag)}`
      : undefined;

  return {
    type: 'video',
    title,
    videoId,
    videoThumbnails: buildThumbnails(videoId),
    description,
    descriptionHtml: textToHtml(description),
    published: Math.floor(Date.now() / 1000),
    publishedText,
    keywords: [],
    viewCount,
    viewCountText: viewText || formatViewsLabel(viewCount),
    likeCount: Number(info?.basic_info?.like_count || 0),
    isFamilyFriendly: true,
    genre: 'Media',
    author,
    authorId,
    authorUrl: authorId ? `/channel/${authorId}` : '',
    authorVerified: Boolean(info?.secondary_info?.owner?.author?.is_verified),
    authorThumbnails: authorThumb
      ? [{ url: proxyMediaUrl(authorThumb), width: 88, height: 88 }]
      : raceData?.authorThumbnails || [],
    subCountText,
    lengthSeconds,
    liveNow: false,
    isUpcoming: false,
    adaptiveFormats,
    formatStreams,
    recommendedVideos,
    maxResolution: maxResFromAdaptive,
    directStreamAvailable: hasDirectStreams,
    streamErrorReason,
    clientRelayStreams,
    hlsManifestUrl,
    hlsProxyUrl,
    googlevideoProxyUrl,
    eduEmbed,
    upstreamSource: companionData?.upstreamSource || directData?.source || raceData?.upstreamSource || 'kuro-companion-edge',
  };
}

// ---------------------------------------------------------------------------
// 5 Dedicated Stream-Capable Origin Servers (127.0.0.1:3001-3005) +
// Public Headless API Reverse Proxy Gateway (0.0.0.0:3000)
// ---------------------------------------------------------------------------
const ORIGIN_PORT = 3001;
const ORIGIN_PORTS = [3001, 3002, 3003, 3004, 3005] as const;
const ORIGIN_HOST = '127.0.0.1';
const ORIGIN_AUTH_TOKEN = crypto.randomBytes(32).toString('hex');

interface OriginInstanceDef {
  id: string;
  serverNumber: number;
  name: string;
  port: number;
  tier: ServerTier;
  tierLabel: string;
  endpoint: string;
  streamEndpoint: string;
  infoEndpoint: string;
  protocol: string;
  capabilities: string[];
  priority: number;
}

const ORIGIN_INSTANCES: OriginInstanceDef[] = [
  {
    id: 'kuro-srv-1',
    serverNumber: 1,
    name: 'Stream Server 1 · 超高速エッジ Range MP4 (:3001)',
    port: 3001,
    tier: 'fast',
    tierLabel: '超高速型',
    endpoint: '/api/server/1/stream/:id',
    streamEndpoint: '/api/server/1/stream/:id',
    infoEndpoint: '/api/server/1/info/:id',
    protocol: 'HTTP/1.1 206 Range · Keep-Alive MP4',
    capabilities: ['超高速起動', 'HTTP 206 シーク', 'Companion直結'],
    priority: 1,
  },
  {
    id: 'kuro-srv-2',
    serverNumber: 2,
    name: 'Stream Server 2 · 超高画質 FFmpeg Mux 4K/1080p (:3002)',
    port: 3002,
    tier: 'hq',
    tierLabel: '高画質型',
    endpoint: '/api/server/2/stream/:id',
    streamEndpoint: '/api/server/2/stream/:id',
    infoEndpoint: '/api/server/2/info/:id',
    protocol: 'Fragmented MP4 · Zero-Transcode Copy',
    capabilities: ['4K/1080p60高画質', 'FFmpegリアルタイム結合', '高音質AAC'],
    priority: 1,
  },
  {
    id: 'kuro-srv-3',
    serverNumber: 3,
    name: 'Stream Server 3 · Adaptive HLS (.m3u8) (:3003)',
    port: 3003,
    tier: 'hq',
    tierLabel: '高画質HLS型',
    endpoint: '/api/server/3/stream/:id',
    streamEndpoint: '/api/server/3/stream/:id',
    infoEndpoint: '/api/server/3/info/:id',
    protocol: 'HLS MPEG-TS (.m3u8 + .ts)',
    capabilities: ['Adaptive HLS', '無停止高速シーク', 'H.264+AAC Copy'],
    priority: 2,
  },
  {
    id: 'kuro-srv-4',
    serverNumber: 4,
    name: 'Stream Server 4 · 超安定 H.264/AAC 端末互換 (:3004)',
    port: 3004,
    tier: 'stable',
    tierLabel: '超安定型',
    endpoint: '/api/server/4/stream/:id',
    streamEndpoint: '/api/server/4/stream/:id',
    infoEndpoint: '/api/server/4/info/:id',
    protocol: 'Universal H.264/AAC Progressive MP4',
    capabilities: ['学校端末100%互換', '多重リトライ', 'iOS/Android/PC対応'],
    priority: 1,
  },
  {
    id: 'kuro-srv-5',
    serverNumber: 5,
    name: 'Stream Server 5 · 自律フォールバック & 外部レース統合 (:3005)',
    port: 3005,
    tier: 'stable',
    tierLabel: '統合フォールバック型',
    endpoint: '/api/server/5/stream/:id',
    streamEndpoint: '/api/server/5/stream/:id',
    infoEndpoint: '/api/server/5/info/:id',
    protocol: 'Multi-Source Race · Auto-Failover MP4',
    capabilities: ['全ソース並列レース', '自動復旧', '1080p→360p安全降格'],
    priority: 2,
  },
];

const instanceRequestCounts = new Map<number, number>(ORIGIN_PORTS.map((p) => [p, 0]));
let rrCursor = 0;

function pickOriginPortForPath(reqUrl: string): number[] {
  const pathLower = reqUrl.toLowerCase();
  const explicitMatch = pathLower.match(/^\/api\/server\/([1-5])(?:\/|\?|$)/);
  if (explicitMatch) {
    const pinnedPort = 3000 + Number(explicitMatch[1]);
    return [pinnedPort, ...ORIGIN_PORTS.filter((p) => p !== pinnedPort)];
  }

  let preferredPool: readonly number[];
  if (pathLower.includes('/googlevideo') || pathLower.includes('/fast-stream') || pathLower.includes('/latest_version')) {
    preferredPool = [3001, 3005];
  } else if (pathLower.includes('/hq-stream') || pathLower.includes('/stream/mux') || pathLower.includes('/4k-stream')) {
    preferredPool = [3002, 3005];
  } else if (pathLower.includes('/stream/hls')) {
    preferredPool = [3003, 3002];
  } else if (pathLower.includes('/stable-stream') || pathLower.includes('/edu-embed')) {
    preferredPool = [3004, 3001];
  } else if (pathLower.includes('/auto-fallback') || pathLower.includes('/external-recover') || pathLower.includes('/live-servers')) {
    preferredPool = [3005, 3001, 3004];
  } else {
    preferredPool = ORIGIN_PORTS;
  }

  const idx = rrCursor++ % preferredPool.length;
  const primary = preferredPool[idx];
  const fallback = ORIGIN_PORTS.filter((p) => p !== primary);
  return [primary, ...fallback];
}

const shieldRules: ShieldRules = {
  rateLimitPerMinute: 240,
  wafStrictMode: true,
  stripClientHeaders: true,
  originPort: ORIGIN_PORT,
  proxyPort: PORT,
};

const shieldCounters = {
  totalProxied: 0,
  allowed: 0,
  cacheHits: 0,
  rateLimited: 0,
  wafBlocked: 0,
};

const shieldAuditLog: ShieldAuditEntry[] = [];
const rateLimitBuckets = new Map<string, number[]>();

function maskIp(ip: string): string {
  const cleaned = ip.replace(/^::ffff:/, '');
  if (cleaned.includes('.')) {
    const parts = cleaned.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`;
  }
  if (cleaned === '::1' || cleaned === '127.0.0.1') return '127.0.*.*';
  return `${cleaned.slice(0, 8)}:**`;
}

function recordAudit(entry: Omit<ShieldAuditEntry, 'id' | 'timestamp'>): void {
  shieldAuditLog.unshift({
    id: crypto.randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (shieldAuditLog.length > 50) shieldAuditLog.length = 50;
}

function detectWafThreat(req: express.Request): string | null {
  const rawUrl = req.originalUrl || req.url || '';
  const decoded = (() => {
    try {
      return decodeURIComponent(rawUrl);
    } catch {
      return rawUrl;
    }
  })();

  if (/\.\.[/\\]/.test(decoded) || /%2e%2e/i.test(rawUrl)) {
    return 'パストラバーサル検知 (Path Traversal)';
  }
  if (/(<script|javascript:|onerror=|onload=)/i.test(decoded)) {
    return 'XSS ペイロード検知';
  }
  if (/(union\s+select|drop\s+table|;\s*--)/i.test(decoded)) {
    return 'SQL インジェクションパターン検知';
  }
  if (/(\/etc\/passwd|169\.254\.169\.254|metadata\.google\.internal)/i.test(decoded)) {
    return 'SSRF / 内部メタデータアクセス検知';
  }
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > 262_144) {
    return 'ペイロードサイズ上限超過 (>256KB)';
  }
  return null;
}

function checkRateLimit(clientIp: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const windowStart = now - 60_000;
  const timestamps = (rateLimitBuckets.get(clientIp) || []).filter((t) => t > windowStart);
  if (timestamps.length >= shieldRules.rateLimitPerMinute) {
    const oldest = timestamps[0] || now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));
    rateLimitBuckets.set(clientIp, timestamps);
    return { allowed: false, retryAfterSec };
  }
  timestamps.push(now);
  rateLimitBuckets.set(clientIp, timestamps);
  return { allowed: true, retryAfterSec: 0 };
}

async function startServer(): Promise<void> {
  // 1. Shared Origin Router mounted across 10 isolated Loopback HTTP Instances (127.0.0.1:3001 - 3010)
  const originRouter = express.Router();

  // Timing & Edge Metrics middleware on Origin API routes
  originRouter.use(['/api/v1', '/api/kuro'], (_req, res, next) => {
    const start = performance.now();
    const originalJson = res.json.bind(res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.json = ((body: any) => {
      const elapsed = Math.max(0.05, performance.now() - start);
      metrics.totalRequests += 1;
      metrics.totalLatencyMs += elapsed;
      if (!res.headersSent) {
        res.setHeader('X-Response-Time', `${elapsed.toFixed(2)}ms`);
      }
      return originalJson(body);
    }) as typeof res.json;
    next();
  });

  // Alias origin routes onto `app` variable so all route handlers mount across all 10 Origin Instances
  const app = originRouter;

  // 1. GET /api/v1/stats
  app.get('/api/v1/stats', (_req, res) => {
    const total = metrics.hits + metrics.misses;
    const hitRate = total > 0 ? Math.round((metrics.hits / total) * 1000) / 10 : 0;
    const avgLatency =
      metrics.totalRequests > 0
        ? Math.round((metrics.totalLatencyMs / metrics.totalRequests) * 100) / 100
        : 0;

    res.setHeader('X-Cache', 'DYNAMIC');
    res.setHeader('X-Upstream-Node', 'kurostream-edge');

    const payload: InvidiousStats = {
      version: '2.0',
      software: {
        name: 'kurostream-invidious',
        version: '2.6.0-4k',
        branch: 'main',
      },
      openRegistrations: false,
      usage: {
        users: {
          total: 1,
          activeHalfyear: 1,
          activeMonth: 1,
        },
      },
      metadata: {
        updatedAt: Math.floor(Date.now() / 1000),
        lastChannelRefreshedAt: Math.floor(Date.now() / 1000),
      },
      performance: {
        cacheHits: metrics.hits,
        cacheMisses: metrics.misses,
        hitRatePercent: hitRate,
        cacheEntries: edgeCache.size,
        avgLatencyMs: avgLatency,
        uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
        nodeRegion: 'JP-Edge',
      },
    };
    res.json(payload);
  });

  // 2. POST /api/v1/cache/purge
  app.post('/api/v1/cache/purge', (_req, res) => {
    const cleared = edgeCache.size;
    edgeCache.clear();
    res.setHeader('X-Cache', 'PURGED');
    res.setHeader('X-Upstream-Node', 'kurostream-edge');
    res.json({ ok: true, clearedEntries: cleared });
  });

  // 3. GET /api/v1/instances
  app.get('/api/v1/instances', async (_req, res) => {
    try {
      const nodes = await discoverUpstreamNodes();
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Upstream-Node', 'node-prober');
      res.json(nodes);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Instance probe failed' });
    }
  });

  // 4. GET /api/v1/search/suggestions (UTF-8 Japanese-safe YouTube predictive autocomplete)
  app.get('/api/v1/search/suggestions', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Upstream-Node', 'kurostream-edge');
      res.json({ query: '', suggestions: [] });
      return;
    }

    const cacheKey = `suggest:v2:${q.toLowerCase()}`;
    const cached = cacheGet<{ query: string; suggestions: string[] }>(cacheKey);
    if (cached.hit && cached.data) {
      metrics.hits += 1;
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Upstream-Node', cached.source || 'l1-cache');
      res.json(cached.data);
      return;
    }

    metrics.misses += 1;
    try {
      const suggestUrl = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=ja&gl=JP&ie=utf8&oe=utf8&q=${encodeURIComponent(q)}`;
      const upstream = await proxiedFetch(suggestUrl, {
        headers: {
          'Accept': 'application/json',
          'Accept-Language': 'ja,en;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(3000),
      });
      if (!upstream.ok) {
        throw new Error(`Suggest upstream HTTP ${upstream.status}`);
      }
      const parsed = (await upstream.json()) as [string, string[]];
      const rawList = Array.isArray(parsed?.[1]) ? parsed[1] : [];
      const cleanList = [...new Set(rawList.map((s) => String(s).trim()).filter(Boolean))].slice(0, 10);
      const payload = { query: q, suggestions: cleanList };
      cacheSet(cacheKey, payload, 300_000, 'yt-suggest-utf8');
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Upstream-Node', 'yt-suggest-utf8');
      res.json(payload);
    } catch {
      // Fallback: extract matching titles from local L1 cache if upstream temporarily throttles
      const lowerQ = q.toLowerCase();
      const localMatches: string[] = [];
      for (const entry of edgeCache.values()) {
        if (Array.isArray(entry.data)) {
          for (const item of entry.data) {
            if (item && typeof item.title === 'string' && item.title.toLowerCase().includes(lowerQ)) {
              localMatches.push(item.title);
            }
          }
        }
        if (localMatches.length >= 6) break;
      }
      res.setHeader('X-Cache', 'DYNAMIC');
      res.setHeader('X-Upstream-Node', 'local-suggest-fallback');
      res.json({ query: q, suggestions: [...new Set(localMatches)].slice(0, 6) });
    }
  });

  // 5. GET /api/v1/search
  app.get('/api/v1/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || 'video');
    const sortBy = String(req.query.sort_by || 'relevance');
    const refresh = req.query.refresh === 'true';

    if (!q) {
      res.status(400).json({ error: 'Query parameter "q" is required' });
      return;
    }

    const cacheKey = `search:${q.toLowerCase()}:${type}:${sortBy}`;
    if (!refresh) {
      const cached = cacheGet<SearchVideoItem[]>(cacheKey);
      if (cached.hit && !cached.stale && cached.data) {
        metrics.hits += 1;
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Upstream-Node', cached.source || 'l1-cache');
        res.json(cached.data);
        return;
      }
    }

    metrics.misses += 1;
    try {
      let items: SearchVideoItem[] = [];
      let usedSource = 'innertube-search';
      try {
        const yt = await getYt();
        const searchRes = await yt.search(q, {
          type: type === 'channel' || type === 'playlist' ? type : 'video',
          prioritize: sortBy === 'view_count' || sortBy === 'rating' ? 'popularity' : 'relevance',
          upload_date: sortBy === 'upload_date' ? 'month' : 'all',
        });
        for (const v of searchRes.videos || []) {
          const mapped = mapRawVideoItem(v);
          if (mapped) items.push(mapped);
        }
      } catch {
        // Fallback directly to external proxy pool
      }

      if (items.length === 0) {
        items = await searchViaExternalProxy(q, type, sortBy);
        usedSource = 'external-proxy-search';
      }

      cacheSet(cacheKey, items, 180_000, usedSource);
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Upstream-Node', usedSource);
      res.json(items);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Search failed' });
    }
  });

  // 6. GET /api/v1/trending
  app.get('/api/v1/trending', async (req, res) => {
    const type = String(req.query.type || '4K');
    const region = String(req.query.region || 'JP').toUpperCase();
    const refresh = req.query.refresh === 'true';

    const cacheKey = `trending:${type}:${region}`;
    if (!refresh) {
      const cached = cacheGet<SearchVideoItem[]>(cacheKey);
      if (cached.hit && !cached.stale && cached.data) {
        metrics.hits += 1;
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Upstream-Node', cached.source || 'l1-cache');
        res.json(cached.data);
        return;
      }
    }

    metrics.misses += 1;
    const regionLabel = region === 'JP' ? 'Japan' : region === 'US' ? 'USA' : region === 'DE' ? 'Germany' : region;
    const queryMap: Record<string, string> = {
      '4K': `4K HDR 60fps ${region === 'JP' ? 'Japan 東京' : 'Ultra HD Nature'}`,
      Default: `${regionLabel} popular trending 4K`,
      Music: `Official Music Video 4K ${region === 'JP' ? 'J-POP' : ''}`,
      Gaming: `4K 60fps Gaming Showcase Trailer`,
      Tech: `4K Tech Review OLED Hardware`,
    };
    const searchQuery = queryMap[type] || queryMap['4K'];

    try {
      let items: SearchVideoItem[] = [];
      let usedSource = 'innertube-feed';
      try {
        const yt = await getYt();
        const searchRes = await yt.search(searchQuery, {
          type: 'video',
          prioritize: 'relevance',
          features: type === '4K' ? ['4k'] : undefined,
        });
        for (const v of searchRes.videos || []) {
          const mapped = mapRawVideoItem(v);
          if (mapped) items.push(mapped);
          if (items.length >= 24) break;
        }
      } catch {
        // fallback below
      }

      if (items.length === 0) {
        items = await searchViaExternalProxy(searchQuery, 'video', 'relevance');
        usedSource = 'external-proxy-feed';
      }

      cacheSet(cacheKey, items, 300_000, usedSource);
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Upstream-Node', usedSource);
      res.json(items);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Trending feed failed' });
    }
  });

  // 7. GET /api/v1/videos/:id
  app.get('/api/v1/videos/:id', async (req, res) => {
    const videoId = String(req.params.id || '').trim();
    const refresh = req.query.refresh === 'true';

    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).json({ error: 'Invalid YouTube video ID' });
      return;
    }

    const cacheKey = `video:${videoId}`;
    if (!refresh) {
      const cached = cacheGet<VideoResponse>(cacheKey);
      if (cached.hit && !cached.stale && cached.data) {
        metrics.hits += 1;
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Upstream-Node', cached.source || 'l1-cache');
        res.json(cached.data);
        return;
      }
    }

    metrics.misses += 1;
    try {
      const data = await fetchVideoFull(videoId);
      cacheSet(cacheKey, data, 300_000, data.upstreamSource || 'innertube-edge');
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Upstream-Node', data.upstreamSource || 'innertube-edge');
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Video lookup failed' });
    }
  });

  // 8. GET /api/v1/comments/:id
  app.get('/api/v1/comments/:id', async (req, res) => {
    const videoId = String(req.params.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).json({ error: 'Invalid video ID' });
      return;
    }

    const cacheKey = `comments:${videoId}`;
    const cached = cacheGet<CommentsResponse>(cacheKey);
    if (cached.hit && !cached.stale && cached.data) {
      metrics.hits += 1;
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Upstream-Node', cached.source || 'l1-cache');
      res.json(cached.data);
      return;
    }

    metrics.misses += 1;
    try {
      const comments: CommentItem[] = [];
      let usedSource = 'innertube-comments';
      try {
        const yt = await getYt();
        const thread = await yt.getComments(videoId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const c of (thread.contents || []) as any[]) {
          const cm = c?.comment;
          if (!cm) continue;
          const content = cm.content?.text || '';
          if (!content) continue;
          const author = cm.author?.name || 'Anonymous';
          const authorId = cm.author?.id || '';
          const avatar = cm.author?.thumbnails?.[0]?.url || '';
          comments.push({
            author,
            authorThumbnails: avatar ? [{ url: proxyMediaUrl(avatar), width: 48, height: 48 }] : [],
            authorId,
            authorUrl: authorId ? `/channel/${authorId}` : '',
            isEdited: false,
            content,
            contentHtml: textToHtml(content),
            published: Math.floor(Date.now() / 1000),
            publishedText: cm.published?.text || '',
            likeCount: parseViewCount(cm.vote_count?.text || cm.like_count),
            commentId: cm.comment_id || `${videoId}_${comments.length}`,
            authorIsChannelOwner: Boolean(cm.author?.is_verified),
            replies: cm.reply_count ? { replyCount: Number(cm.reply_count) || 0 } : undefined,
          });
        }
      } catch {
        // fallback below
      }

      let payload: CommentsResponse = {
        commentCount: comments.length,
        videoId,
        comments,
      };
      if (comments.length === 0) {
        const ext = await fetchCommentsViaExternalProxy(videoId);
        if (ext) {
          payload = ext;
          usedSource = 'external-proxy-comments';
        }
      }

      cacheSet(cacheKey, payload, 300_000, usedSource);
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Upstream-Node', usedSource);
      res.json(payload);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Comments fetch failed' });
    }
  });

  // 9. GET /api/v1/channels/:id
  app.get('/api/v1/channels/:id', async (req, res) => {
    const channelId = String(req.params.id || '').trim();
    if (!channelId) {
      res.status(400).json({ error: 'Channel ID required' });
      return;
    }

    const cacheKey = `channel:${channelId}`;
    const cached = cacheGet<ChannelResponse>(cacheKey);
    if (cached.hit && !cached.stale && cached.data) {
      metrics.hits += 1;
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Upstream-Node', cached.source || 'l1-cache');
      res.json(cached.data);
      return;
    }

    metrics.misses += 1;
    try {
      let payload: ChannelResponse | null = null;
      let usedSource = 'innertube-channel';
      try {
        const yt = await getYt();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ch: any = await yt.getChannel(channelId);
        const latestVideos: SearchVideoItem[] = [];
        for (const v of ch?.videos || []) {
          const mapped = mapRawVideoItem(v);
          if (mapped) latestVideos.push(mapped);
          if (latestVideos.length >= 24) break;
        }
        const avatar = ch?.metadata?.avatar?.[0]?.url || ch?.header?.author?.thumbnails?.[0]?.url || '';
        const banner = ch?.header?.banner?.[0]?.url || '';
        const subText = ch?.header?.subscribers?.text || '';
        payload = {
          author: ch?.metadata?.title || 'Channel',
          authorId: channelId,
          authorUrl: `/channel/${channelId}`,
          authorBanners: banner ? [{ url: proxyMediaUrl(banner), width: 1280, height: 240 }] : [],
          authorThumbnails: avatar ? [{ url: proxyMediaUrl(avatar), width: 176, height: 176 }] : [],
          subCount: parseViewCount(subText),
          subCountText: subText,
          totalViews: 0,
          joined: 0,
          autoGenerated: false,
          isFamilyFriendly: Boolean(ch?.metadata?.is_family_safe ?? true),
          description: ch?.metadata?.description || '',
          descriptionHtml: textToHtml(ch?.metadata?.description || ''),
          latestVideos,
        };
      } catch {
        // fallback below
      }

      if (!payload || payload.latestVideos.length === 0) {
        const extCh = await fetchChannelViaExternalProxy(channelId);
        if (extCh) {
          payload = extCh;
          usedSource = 'external-proxy-channel';
        }
      }

      if (!payload) {
        res.status(502).json({ error: 'Channel lookup failed across all proxy nodes' });
        return;
      }

      cacheSet(cacheKey, payload, 300_000, usedSource);
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Upstream-Node', usedSource);
      res.json(payload);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Channel lookup failed' });
    }
  });

  // 10. GET /api/v1/thumbnail/:id/:quality (Cached Proxy with Invidious/ytimg multi-relay fallback)
  app.get('/api/v1/thumbnail/:id/:quality', async (req, res) => {
    const videoId = String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const requested = String(req.params.quality || 'maxresdefault').replace(/[^a-zA-Z0-9_-]/g, '');
    const thumbCacheKey = `thumb:${videoId}:${requested}`;
    const cachedThumb = cacheGet<Buffer>(thumbCacheKey);
    if (cachedThumb.hit && cachedThumb.data) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.send(cachedThumb.data);
      return;
    }

    const order =
      requested === 'maxresdefault'
        ? ['maxresdefault', 'sddefault', 'hqdefault']
        : requested === 'sddefault'
          ? ['sddefault', 'hqdefault', 'mqdefault']
          : [requested, 'hqdefault'];

    for (const q of order) {
      try {
        const upstream = await proxiedFetch(`https://i.ytimg.com/vi/${videoId}/${q}.jpg`, {
          headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
          signal: AbortSignal.timeout(2600),
        });
        if (upstream.ok) {
          const buf = Buffer.from(await upstream.arrayBuffer());
          cacheSet(thumbCacheKey, buf, 1_800_000, 'ytimg-proxy');
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
          res.send(buf);
          return;
        }
      } catch {
        // try next fallback quality or Invidious mirror
      }
    }

    const invMirrors = getRankedExternalCandidates(
      'invidious',
      FALLBACK_INVIDIOUS_HOSTS.slice(0, 3).map((h) => `https://${h}`),
    ).slice(0, 2);
    for (const host of invMirrors) {
      try {
        const upstream = await proxiedFetch(`${host}/vi/${videoId}/hqdefault.jpg`, {
          headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
          signal: AbortSignal.timeout(2500),
        });
        if (upstream.ok) {
          const buf = Buffer.from(await upstream.arrayBuffer());
          cacheSet(thumbCacheKey, buf, 1_800_000, 'invidious-thumb-proxy');
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
          res.send(buf);
          return;
        }
      } catch {
        // continue
      }
    }
    res.status(404).end();
  });

  // 10b. GET /api/v1/media-proxy (SSRF-safe YouTube/Invidious Avatar & Banner Image Proxy)
  app.get('/api/v1/media-proxy', async (req, res) => {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) {
      res.status(400).end();
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      res.status(400).end();
      return;
    }
    const allowedHosts = ['i.ytimg.com', 'i9.ytimg.com', 's.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com'];
    const hostOk =
      parsed.protocol === 'https:' &&
      !isPrivateOrLocalHostname(parsed.hostname) &&
      allowedHosts.some((d) => parsed.hostname === d || parsed.hostname.endsWith(`.${d}`));
    if (!hostOk) {
      res.status(403).json({ error: '許可されていないメディアホストです' });
      return;
    }

    const cacheKey = `mimg:${crypto.createHash('sha1').update(rawUrl).digest('hex').slice(0, 16)}`;
    const cached = cacheGet<{ buf: Buffer; ct: string }>(cacheKey);
    if (cached.hit && cached.data) {
      res.setHeader('Content-Type', cached.data.ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('X-Cache', 'HIT');
      res.send(cached.data.buf);
      return;
    }

    try {
      const upstream = await proxiedFetch(rawUrl, {
        headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
        signal: AbortSignal.timeout(4000),
      });
      if (!upstream.ok) {
        res.status(upstream.status).end();
        return;
      }
      const ct = upstream.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await upstream.arrayBuffer());
      cacheSet(cacheKey, { buf, ct }, 1_800_000, 'media-proxy');
      res.setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buf);
    } catch {
      res.status(502).end();
    }
  });

  // 10c. GET /api/v1/stream/relay/:id (Server-Side Protected External Relay Stream Proxy)
  app.get('/api/v1/stream/relay/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    const host = String(req.query.host || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const itag = String(req.query.itag || '18').trim();
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(id) || !host || isPrivateOrLocalHostname(host)) {
      res.status(400).json({ error: '不正なリレーリクエストです' });
      return;
    }
    const targetUrl = `https://${host}/latest_version?id=${encodeURIComponent(id)}&itag=${encodeURIComponent(itag)}&local=true`;
    try {
      const upstream = await proxiedFetch(targetUrl, {
        headers: buildMaskedUpstreamHeaders(req.headers.range, targetUrl),
        signal: AbortSignal.timeout(18000),
      });
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type') || 'video/mp4';
      const cl = upstream.headers.get('content-length');
      const cr = upstream.headers.get('content-range');
      res.setHeader('Content-Type', ct);
      res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
      res.setHeader('X-Upstream-Node', `relay-proxy:${host}`);
      if (cl) res.setHeader('Content-Length', cl);
      if (cr) res.setHeader('Content-Range', cr);
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      res.on('close', () => {
        if (!res.writableEnded) reader.cancel().catch(() => {});
      });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writableEnded) res.write(Buffer.from(value));
      }
      res.end();
    } catch {
      if (!res.headersSent) {
        res.status(502).json({ error: 'リレープロキシ取得エラー' });
      }
    }
  });

  // 11. GET /latest_version (Ultra-stable self-healing Range stream proxy with upstream failover)
  app.get('/latest_version', async (req, res) => {
    const id = String(req.query.id || '').trim();
    const itag = String(req.query.itag || '18').trim();
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(id) || !itag) {
      res.status(400).json({ error: 'Missing or invalid id or itag parameter' });
      return;
    }

    let cached = cacheGet<{ url: string; type: string }>(`stream:${id}:${itag}`);
    if (!cached.hit || !cached.data?.url) {
      try {
        await fetchVideoFull(id);
        cached = cacheGet<{ url: string; type: string }>(`stream:${id}:${itag}`);
      } catch {
        // ignore, failover handles companion direct URL
      }
    }
    const targetUrl = cached.data?.url || companionStreamUrl(id, itag);

    try {
      const upstream = await fetchUpstreamMediaWithFailover(id, itag, targetUrl, req.headers.range);

      res.status(upstream.status);
      const ct = upstream.headers.get('content-type') || (itag === '140' ? 'audio/mp4' : itag === '251' ? 'audio/webm' : 'video/mp4');
      const cl = upstream.headers.get('content-length');
      const cr = upstream.headers.get('content-range');
      const ar = upstream.headers.get('accept-ranges') || 'bytes';
      res.setHeader('Content-Type', ct);
      res.setHeader('Accept-Ranges', ar);
      if (cl) res.setHeader('Content-Length', cl);
      if (cr) res.setHeader('Content-Range', cr);

      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      res.on('close', () => {
        if (!res.writableEnded) reader.cancel().catch(() => {});
      });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writableEnded) res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'Stream proxy error' });
      }
    }
  });

  // Helper: Stream FFmpeg-muxed HD/1080p/4K MP4 cleanly with first-byte verification + progressive fallback
  async function streamMuxedMp4Response(
    videoId: string,
    res: express.Response,
    opts: { maxHeight?: number; seekSec?: number; vItag?: string; aItag?: string; rangeHeader?: string } = {},
  ): Promise<void> {
    const maxHeight = opts.maxHeight || 2160;
    const seekSec = Math.max(0, Number(opts.seekSec || 0) || 0);
    let video = cacheGet<VideoResponse>(`video:${videoId}`).data;
    if (!video || (!video.adaptiveFormats?.length && !video.formatStreams?.length)) {
      video = await fetchVideoFull(videoId).catch(() => undefined);
      if (video) cacheSet(`video:${videoId}`, video, 300_000, video.upstreamSource || 'kuro-companion');
    }

    const vTracks = (video?.adaptiveFormats || [])
      .filter((f) => f.type.startsWith('video/') && f.url)
      .sort((a, b) => {
        const hA = parseInt(a.qualityLabel || '0', 10) || 0;
        const hB = parseInt(b.qualityLabel || '0', 10) || 0;
        if (hB !== hA) return hB - hA;
        // Prefer H.264 (avc1) for universal MP4 browser compatibility at equal resolution
        const aH264 = /avc1/i.test(a.type + a.encoding) ? 1 : 0;
        const bH264 = /avc1/i.test(b.type + b.encoding) ? 1 : 0;
        if (bH264 !== aH264) return bH264 - aH264;
        return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
      });
    const aTracks = (video?.adaptiveFormats || [])
      .filter((f) => f.type.startsWith('audio/') && f.url)
      .sort((a, b) => {
        const aAac = /mp4a/i.test(a.type + a.encoding) ? 1 : 0;
        const bAac = /mp4a/i.test(b.type + b.encoding) ? 1 : 0;
        if (bAac !== aAac) return bAac - aAac;
        return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
      });

    const vPicked =
      (opts.vItag ? vTracks.find((v) => v.itag === opts.vItag) : null) ||
      vTracks.find((v) => (parseInt(v.qualityLabel || '0', 10) || 0) <= maxHeight && /avc1/i.test(v.type + v.encoding)) ||
      vTracks.find((v) => (parseInt(v.qualityLabel || '0', 10) || 0) <= maxHeight) ||
      vTracks[0] ||
      null;
    const aPicked =
      (opts.aItag ? aTracks.find((a) => a.itag === opts.aItag) : null) ||
      aTracks[0] ||
      null;

    if (vPicked?.url && aPicked?.url && FFMPEG_AVAILABLE) {
      const vUrl = vPicked.url;
      const aUrl = aPicked.url;
      const isAudioAac = /mp4a/i.test(aPicked.type + aPicked.encoding) || aPicked.itag === '140';
      const ffArgs: string[] = ['-loglevel', 'error'];
      if (streamConfig.outboundProxyUrl && /^https?:\/\//i.test(streamConfig.outboundProxyUrl)) {
        ffArgs.push('-http_proxy', streamConfig.outboundProxyUrl);
      }
      ffArgs.push('-user_agent', ANUBIS_UA);
      if (seekSec > 0) ffArgs.push('-ss', seekSec.toFixed(2));
      ffArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3', '-i', vUrl);
      ffArgs.push('-user_agent', ANUBIS_UA);
      if (seekSec > 0) ffArgs.push('-ss', seekSec.toFixed(2));
      ffArgs.push(
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3', '-i', aUrl,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        ...(isAudioAac ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4',
        'pipe:1',
      );

      const okMuxed = await new Promise<boolean>((resolve) => {
        const ff = spawn(FFMPEG_BIN, ffArgs);
        let started = false;
        const startTimeout = setTimeout(() => {
          if (!started) {
            ff.kill('SIGKILL');
            resolve(false);
          }
        }, 12_000);

        res.on('close', () => {
          clearTimeout(startTimeout);
          if (!res.writableEnded) ff.kill('SIGKILL');
          resolve(started);
        });

        ff.stdout.on('data', (chunk: Buffer) => {
          if (!started) {
            started = true;
            clearTimeout(startTimeout);
            if (!res.headersSent) {
              res.status(200);
              res.setHeader('Content-Type', 'video/mp4');
              res.setHeader('Cache-Control', 'no-store');
              res.setHeader('X-Stream-Mode', 'ffmpeg-mux-copy');
              res.setHeader('X-Stream-Quality', vPicked.qualityLabel || vPicked.itag);
            }
          }
          if (!res.writableEnded) res.write(chunk);
        });

        ff.stdout.on('end', () => {
          clearTimeout(startTimeout);
          if (started && !res.writableEnded) res.end();
          resolve(started);
        });

        ff.on('error', () => {
          clearTimeout(startTimeout);
          resolve(started);
        });

        ff.on('exit', () => {
          clearTimeout(startTimeout);
          if (started && !res.writableEnded) res.end();
          resolve(started);
        });
      });

      if (okMuxed) return;
    }

    // Fallback: Guaranteed Progressive H.264/AAC MP4 (itag=18) with full HTTP 206 Range support
    const progItag = video?.formatStreams?.[0]?.itag || '18';
    const progUrl = video?.formatStreams?.[0]?.url || companionStreamUrl(videoId, progItag);
    const upstream = await fetchUpstreamMediaWithFailover(videoId, progItag, progUrl, opts.rangeHeader);
    if (res.headersSent) return;
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
    res.setHeader('X-Stream-Mode', 'progressive-fallback');
    const cl = upstream.headers.get('content-length');
    const cr = upstream.headers.get('content-range');
    if (cl) res.setHeader('Content-Length', cl);
    if (cr) res.setHeader('Content-Range', cr);
    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    res.on('close', () => {
      if (!res.writableEnded) reader.cancel().catch(() => {});
    });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.writableEnded) res.write(Buffer.from(value));
    }
    res.end();
  }

  // 12. GET /api/v1/stream/mux (Real-time FFmpeg 4K/1080p video + audio fragmented MP4 remuxer with ?t= seek support)
  app.get('/api/v1/stream/mux', async (req, res) => {
    const id = String(req.query.id || '').trim();
    const vItag = String(req.query.v || '').trim() || undefined;
    const aItag = String(req.query.a || '').trim() || undefined;
    const maxHeight = Number(req.query.maxHeight || req.query.q || 2160) || 2160;
    const seekSec = Math.max(0, Number(req.query.t || 0) || 0);

    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
      res.status(400).json({ error: 'Valid video id parameter is required' });
      return;
    }

    try {
      await streamMuxedMp4Response(id, res, {
        maxHeight,
        seekSec,
        vItag,
        aItag,
        rangeHeader: req.headers.range,
      });
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'Mux stream failed' });
      }
    }
  });

  // 12b. GET /api/v1/stream/hls-proxy (Native HLS .m3u8 manifest & segment proxy)
  app.get('/api/v1/stream/hls-proxy', async (req, res) => {
    const rawTarget = String(req.query.url || '').trim();
    if (!rawTarget) {
      res.status(400).json({ error: 'url parameter required' });
      return;
    }
    let targetUrl: URL;
    try {
      targetUrl = new URL(rawTarget);
    } catch {
      res.status(400).json({ error: 'Invalid HLS URL' });
      return;
    }
    if (targetUrl.protocol !== 'https:' || isPrivateOrLocalHostname(targetUrl.hostname)) {
      res.status(403).json({ error: 'Blocked HLS upstream host' });
      return;
    }

    try {
      const upstream = await proxiedFetch(targetUrl.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!upstream.ok) {
        res.status(upstream.status).end();
        return;
      }
      const ct = (upstream.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('mpegurl') || targetUrl.pathname.endsWith('.m3u8')) {
        const text = await upstream.text();
        const rewritten = text
          .split('\n')
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
              return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
                const abs = new URL(uri, targetUrl).toString();
                return `URI="/api/v1/stream/hls-proxy?url=${encodeURIComponent(abs)}"`;
              });
            }
            const abs = new URL(trimmed, targetUrl).toString();
            return `/api/v1/stream/hls-proxy?url=${encodeURIComponent(abs)}`;
          })
          .join('\n');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.send(rewritten);
        return;
      }

      if (ct) res.setHeader('Content-Type', ct);
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      res.on('close', () => {
        if (!res.writableEnded) reader.cancel().catch(() => {});
      });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writableEnded) res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'HLS proxy error' });
      }
    }
  });

  // 12c. Shared On-demand FFmpeg H.264/AAC HLS .m3u8 packager & handler
  const activeHlsJobs = new Map<string, { dir: string; startedAt: number }>();

  async function serveHlsFile(
    id: string,
    file: string,
    segmentPrefix: string,
    res: express.Response,
  ): Promise<void> {
    if (!id || !/^(index\.m3u8|seg_\d{4}\.ts)$/.test(file)) {
      res.status(400).json({ error: 'Invalid HLS request' });
      return;
    }

    const hlsDir = path.join('/tmp/kurostream-hls', id);
    const targetFile = path.join(hlsDir, file);
    const playlistFile = path.join(hlsDir, 'index.m3u8');

    const needsBuild =
      file === 'index.m3u8' &&
      !activeHlsJobs.has(id) &&
      (!fs.existsSync(playlistFile) || !fs.readFileSync(playlistFile, 'utf8').includes('.ts'));

    if (needsBuild) {
      let video = cacheGet<VideoResponse>(`video:${id}`).data;
      if (!video || (!video.adaptiveFormats?.length && !video.formatStreams?.length)) {
        video = await fetchVideoFull(id).catch(() => video);
        if (video) cacheSet(`video:${id}`, video, 300_000, video.upstreamSource || 'kuro-companion');
      }

      const vTracks = (video?.adaptiveFormats || [])
        .filter((f) => f.type.startsWith('video/') && f.url)
        .sort((a, b) => (parseInt(b.qualityLabel || '0', 10) || 0) - (parseInt(a.qualityLabel || '0', 10) || 0));
      const h264Adaptive = vTracks.find(
        (f) => f.encoding.toLowerCase().includes('avc1') || f.type.toLowerCase().includes('avc1'),
      );
      const aTracks = (video?.adaptiveFormats || [])
        .filter((f) => f.type.startsWith('audio/') && f.url)
        .sort((a, b) => {
          const aAac = /mp4a/i.test(a.type + a.encoding) ? 1 : 0;
          const bAac = /mp4a/i.test(b.type + b.encoding) ? 1 : 0;
          if (bAac !== aAac) return bAac - aAac;
          return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
        });
      const prog = video?.formatStreams?.find((f) => f.container === 'mp4' && f.url) || video?.formatStreams?.[0];

      const pickedVideo = h264Adaptive || prog || vTracks[0];
      const vUrl = pickedVideo?.url || companionStreamUrl(id, '18');
      const needsTranscode = Boolean(pickedVideo && !h264Adaptive && pickedVideo !== prog);
      const aPicked = pickedVideo !== prog && aTracks[0] ? aTracks[0] : null;
      const aUrl = aPicked?.url || null;
      const isAudioAac = Boolean(aPicked && (/mp4a/i.test(aPicked.type + aPicked.encoding) || aPicked.itag === '140'));

      if (!vUrl || !FFMPEG_AVAILABLE) {
        res.status(404).json({ error: 'HLS source streams unavailable' });
        return;
      }

      fs.mkdirSync(hlsDir, { recursive: true });
      for (const old of fs.readdirSync(hlsDir)) {
        fs.rmSync(path.join(hlsDir, old), { force: true });
      }

      const ffArgs: string[] = ['-loglevel', 'error'];
      if (streamConfig.outboundProxyUrl && /^https?:\/\//i.test(streamConfig.outboundProxyUrl)) {
        ffArgs.push('-http_proxy', streamConfig.outboundProxyUrl);
      }
      ffArgs.push(
        '-user_agent', ANUBIS_UA,
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-i', vUrl,
      );
      if (aUrl) {
        ffArgs.push(
          '-user_agent', ANUBIS_UA,
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-i', aUrl,
          '-map', '0:v:0',
          '-map', '1:a:0',
        );
      }
      ffArgs.push(
        '-c:v', needsTranscode ? 'libx264' : 'copy',
        ...(needsTranscode ? ['-preset', 'veryfast', '-crf', '22'] : []),
        ...(aUrl && isAudioAac ? ['-c:a', 'copy'] : !aUrl && pickedVideo === prog ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
        '-hls_time', '3',
        '-hls_list_size', '0',
        '-hls_playlist_type', 'event',
        '-hls_flags', 'temp_file',
        '-hls_segment_filename', path.join(hlsDir, 'seg_%04d.ts'),
        playlistFile,
      );

      activeHlsJobs.set(id, { dir: hlsDir, startedAt: Date.now() });
      const ff = spawn(FFMPEG_BIN, ffArgs);
      ff.on('exit', () => {
        setTimeout(() => {
          activeHlsJobs.delete(id);
        }, 600_000);
      });
      ff.on('error', () => activeHlsJobs.delete(id));
    }

    if (file === 'index.m3u8') {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if (fs.existsSync(targetFile) && fs.readFileSync(targetFile, 'utf8').includes('.ts')) {
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (!fs.existsSync(targetFile)) {
        res.status(504).json({ error: 'HLS manifest preparation timeout' });
        return;
      }
      const rawPlaylist = fs.readFileSync(targetFile, 'utf8');
      const rewritten = rawPlaylist
        .split('\n')
        .map((line) => (line.trim().endsWith('.ts') ? `${segmentPrefix}/${line.trim()}` : line))
        .join('\n');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      res.send(rewritten);
      return;
    }

    if (!fs.existsSync(targetFile)) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', 'video/mp2t');
    fs.createReadStream(targetFile).pipe(res);
  }

  app.get('/api/v1/stream/hls-gen/:id/:file', async (req, res) => {
    const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const file = String(req.params.file || '');
    await serveHlsFile(id, file, `/api/v1/stream/hls-gen/${encodeURIComponent(id)}`, res);
  });

  // 12d. GET /api/v1/download/:id (Video & Audio File Download: MP4 Mux / Progressive MP4 / Audio)
  app.get('/api/v1/download/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    const mode = String(req.query.mode || 'mux');
    const vItag = String(req.query.v || '').trim();
    const aItag = String(req.query.a || '').trim();

    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
      res.status(400).json({ error: '不正な動画IDです' });
      return;
    }

    let video = cacheGet<VideoResponse>(`video:${id}`).data;
    if (!video) {
      video = await fetchVideoFull(id).catch(() => undefined);
      if (video) cacheSet(`video:${id}`, video, 300_000, video.upstreamSource || 'innertube-edge');
    }
    if (!video) {
      res.status(404).json({ error: '動画情報の取得に失敗しました' });
      return;
    }

    const safeBaseName = (video.title || id)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 72) || id;

    const setAttachment = (ext: string, contentType: string) => {
      const asciiFallback = `${id}.${ext}`;
      const encodedName = encodeURIComponent(`${safeBaseName}.${ext}`);
      res.setHeader('Content-Type', contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`,
      );
    };

    const pipeUrlDownload = async (targetUrl: string, ext: string, fallbackMime: string) => {
      const upstream = await proxiedFetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!upstream.ok || !upstream.body) {
        res.status(upstream.status || 502).json({ error: '上流ストリームのダウンロードに失敗しました' });
        return;
      }
      const cl = upstream.headers.get('content-length');
      setAttachment(ext, upstream.headers.get('content-type') || fallbackMime);
      if (cl) res.setHeader('Content-Length', cl);
      const reader = upstream.body.getReader();
      res.on('close', () => {
        if (!res.writableEnded) reader.cancel().catch(() => {});
      });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writableEnded) res.write(Buffer.from(value));
      }
      res.end();
    };

    try {
      if (mode === 'audio') {
        const aTracks = video.adaptiveFormats
          .filter((f) => f.type.startsWith('audio/'))
          .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
        const picked = (aItag ? aTracks.find((a) => a.itag === aItag) : null) || aTracks[0];
        if (!picked?.url) {
          res.status(404).json({ error: 'ダウンロード可能な音声ストリームが見つかりません' });
          return;
        }
        const ext = picked.container === 'mp4' ? 'm4a' : 'webm';
        await pipeUrlDownload(picked.url, ext, picked.type || 'audio/mp4');
        return;
      }

      if (mode === 'progressive') {
        const picked = (vItag ? video.formatStreams.find((f) => f.itag === vItag) : null) || video.formatStreams[0];
        if (!picked?.url) {
          res.status(404).json({ error: 'プログレッシブ MP4 ストリームが見つかりません' });
          return;
        }
        await pipeUrlDownload(picked.url, picked.container || 'mp4', 'video/mp4');
        return;
      }

      // Default mode === 'mux': High-res video + audio combined MP4 via FFmpeg
      const vTracks = video.adaptiveFormats
        .filter((f) => f.type.startsWith('video/'))
        .sort((a, b) => (parseInt(b.qualityLabel || '0', 10) || 0) - (parseInt(a.qualityLabel || '0', 10) || 0));
      const aTracks = video.adaptiveFormats
        .filter((f) => f.type.startsWith('audio/'))
        .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));

      const vPicked = (vItag ? vTracks.find((v) => v.itag === vItag) : null) || vTracks[0];
      const aPicked = (aItag ? aTracks.find((a) => a.itag === aItag) : null) || aTracks[0];

      if (!vPicked?.url || !aPicked?.url || !FFMPEG_AVAILABLE) {
        // Fallback to progressive MP4 if adaptive tracks aren't present
        const prog = video.formatStreams[0];
        if (prog?.url) {
          await pipeUrlDownload(prog.url, prog.container || 'mp4', 'video/mp4');
          return;
        }
        res.status(404).json({ error: 'ダウンロード可能な高画質ストリームが未解決です。YouTube デバイス認証またはプロキシ設定後に再試行してください。' });
        return;
      }

      setAttachment('mp4', 'video/mp4');
      const ffArgs: string[] = ['-loglevel', 'error'];
      if (streamConfig.outboundProxyUrl && /^https?:\/\//i.test(streamConfig.outboundProxyUrl)) {
        ffArgs.push('-http_proxy', streamConfig.outboundProxyUrl);
      }
      ffArgs.push(
        '-reconnect', '1', '-reconnect_streamed', '1', '-i', vPicked.url,
        '-reconnect', '1', '-reconnect_streamed', '1', '-i', aPicked.url,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4',
        'pipe:1',
      );
      const ff = spawn(FFMPEG_BIN, ffArgs);
      ff.stdout.pipe(res);
      res.on('close', () => {
        if (!res.writableEnded) ff.kill('SIGKILL');
      });
      ff.on('error', () => {
        if (!res.headersSent) res.status(502).end();
      });
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'ダウンロード処理に失敗しました' });
      }
    }
  });

  // 12e. POST /api/v1/streams/register (Sync browser-resolved streams to origin L1 cache for Googlevideo/Mux/HLS)
  app.post('/api/v1/streams/register', (req, res) => {
    const body = req.body as {
      videoId?: string;
      adaptiveFormats?: AdaptiveFormat[];
      formatStreams?: FormatStream[];
      hlsManifestUrl?: string;
      sourceHost?: string;
    };
    const id = String(body?.videoId || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
      res.status(400).json({ error: '不正な動画IDです' });
      return;
    }

    const isSafeHttps = (u?: string): u is string => {
      if (!u || typeof u !== 'string') return false;
      try {
        const parsed = new URL(u);
        return parsed.protocol === 'https:' && !isPrivateOrLocalHostname(parsed.hostname);
      } catch {
        return false;
      }
    };

    const adaptive = Array.isArray(body?.adaptiveFormats)
      ? body.adaptiveFormats.filter((f) => isSafeHttps(f?.url) && f?.itag)
      : [];
    const formats = Array.isArray(body?.formatStreams)
      ? body.formatStreams.filter((f) => isSafeHttps(f?.url) && f?.itag)
      : [];
    const hlsManifestUrl = isSafeHttps(body?.hlsManifestUrl) ? body.hlsManifestUrl : undefined;

    for (const fmt of [...adaptive, ...formats]) {
      cacheSet(`stream:${id}:${fmt.itag}`, { url: fmt.url, type: fmt.type }, 1_800_000, 'browser-sync');
    }

    const existing = cacheGet<VideoResponse>(`video:${id}`);
    if (existing.hit && existing.data) {
      const updated: VideoResponse = {
        ...existing.data,
        adaptiveFormats: adaptive.length > 0 ? adaptive : existing.data.adaptiveFormats,
        formatStreams: formats.length > 0 ? formats : existing.data.formatStreams,
        hlsManifestUrl: hlsManifestUrl || existing.data.hlsManifestUrl,
        hlsProxyUrl: hlsManifestUrl
          ? `/api/v1/stream/hls-proxy?url=${encodeURIComponent(hlsManifestUrl)}`
          : (adaptive.length > 0 || formats.length > 0) && FFMPEG_AVAILABLE
            ? `/api/v1/stream/hls-gen/${encodeURIComponent(id)}/index.m3u8`
            : existing.data.hlsProxyUrl,
        directStreamAvailable: adaptive.length > 0 || formats.length > 0 || Boolean(hlsManifestUrl),
        streamErrorReason: undefined,
        upstreamSource: body?.sourceHost || existing.data.upstreamSource,
      };
      cacheSet(`video:${id}`, updated, 300_000, body?.sourceHost || 'browser-sync');
    }

    res.json({ ok: true, registeredStreams: adaptive.length + formats.length, hasHls: Boolean(hlsManifestUrl) });
  });

  // 12f. GET /api/v1/stream/googlevideo/:id (Googlevideo MP4 IP-masked ultra-fast Range relay)
  app.get('/api/v1/stream/googlevideo/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    const requestedItag = String(req.query.itag || '').trim();
    const profile = String(req.query.profile || 'fast');
    const rawSrc = String(req.query.src || '').trim();

    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(id)) {
      res.status(400).json({ error: '不正な動画IDです' });
      return;
    }

    const resolveTargetUrl = async (forceRefresh = false): Promise<{ url: string; itag: string } | null> => {
      if (!forceRefresh && rawSrc) {
        try {
          const parsed = new URL(rawSrc);
          if (parsed.protocol === 'https:' && !isPrivateOrLocalHostname(parsed.hostname)) {
            return { url: rawSrc, itag: requestedItag || 'src' };
          }
        } catch {
          // ignore malformed src
        }
      }
      if (!forceRefresh && requestedItag) {
        const directCached = cacheGet<{ url: string }>(`stream:${id}:${requestedItag}`);
        if (directCached.hit && directCached.data?.url) {
          return { url: directCached.data.url, itag: requestedItag };
        }
      }
      let video = !forceRefresh ? cacheGet<VideoResponse>(`video:${id}`).data : undefined;
      if (!video) {
        video = await fetchVideoFull(id).catch(() => undefined);
        if (video) cacheSet(`video:${id}`, video, 300_000, video.upstreamSource || 'googlevideo-edge');
      }
      if (!video) return null;

      if (requestedItag) {
        const exact = [...video.formatStreams, ...video.adaptiveFormats].find((f) => f.itag === requestedItag);
        if (exact?.url) return { url: exact.url, itag: exact.itag };
      }

      const mp4Formats = video.formatStreams.filter((f) => f.container === 'mp4' && f.url);
      if (mp4Formats.length > 0) {
        if (profile === 'stable') {
          const safe360 = mp4Formats.find((f) => f.itag === '18') || mp4Formats[mp4Formats.length - 1];
          return { url: safe360.url, itag: safe360.itag };
        }
        return { url: mp4Formats[0].url, itag: mp4Formats[0].itag };
      }

      const fallbackFmt = video.formatStreams[0] || video.adaptiveFormats[0];
      return fallbackFmt?.url ? { url: fallbackFmt.url, itag: fallbackFmt.itag } : null;
    };

    try {
      let picked = await resolveTargetUrl(false);
      if (req.query.inspect === 'true') {
        res.setHeader('X-Cache', 'DYNAMIC');
        res.setHeader('X-Upstream-Node', 'kuro-googlevideo-relay');
        res.json({
          endpoint: `/api/v1/stream/googlevideo/${id}`,
          videoId: id,
          profile,
          selectedItag: picked?.itag || null,
          streamAvailable: Boolean(picked?.url),
          ipMasked: true,
          headersSanitized: ['x-forwarded-for', 'x-real-ip', 'via', 'cookie', 'referer'],
          proxyRangeUrl: picked?.itag
            ? `/api/v1/stream/googlevideo/${encodeURIComponent(id)}?itag=${encodeURIComponent(picked.itag)}&profile=${encodeURIComponent(profile)}`
            : null,
        });
        return;
      }

      if (!picked?.url) {
        res.status(404).json({ error: 'Googlevideo MP4 ストリームが未解決です。自動フォールバックまたは Edu再生をお試しください。' });
        return;
      }

      const targetUrl = picked?.url || companionStreamUrl(id, picked?.itag || requestedItag || '18');
      const targetItag = picked?.itag || requestedItag || '18';
      const upstream = await fetchUpstreamMediaWithFailover(id, targetItag, targetUrl, req.headers.range);

      res.status(upstream.status);
      const ct = upstream.headers.get('content-type') || 'video/mp4';
      const cl = upstream.headers.get('content-length');
      const cr = upstream.headers.get('content-range');
      const ar = upstream.headers.get('accept-ranges') || 'bytes';
      res.setHeader('Content-Type', ct);
      res.setHeader('Accept-Ranges', ar);
      res.setHeader('X-Googlevideo-Relay', 'ip-masked');
      res.setHeader('X-Googlevideo-Itag', targetItag);
      if (cl) res.setHeader('Content-Length', cl);
      if (cr) res.setHeader('Content-Range', cr);

      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      res.on('close', () => {
        if (!res.writableEnded) reader.cancel().catch(() => {});
      });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writableEnded) res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'Googlevideo 中継エラー' });
      }
    }
  });

  // 12f. POST /api/v1/recommendations/feed (Watch-History Personalized Recommendation Algorithm)
  app.post('/api/v1/recommendations/feed', async (req, res) => {
    const body = req.body as {
      history?: WatchHistoryEntry[];
      excludeIds?: string[];
      region?: string;
    };
    const history = Array.isArray(body?.history) ? body.history.slice(0, 30) : [];
    const excludeSet = new Set<string>((body?.excludeIds || []).map((x) => String(x)));
    for (const h of history.slice(0, 8)) {
      if (h?.videoId) excludeSet.add(h.videoId);
    }

    const region = String(body?.region || 'JP').toUpperCase();

    if (history.length === 0) {
      // Cold-start fallback: blend JP trending + 4K quality feed via proxy-first pipeline
      try {
        const query = region === 'JP' ? '日本 人気 急上昇 4K' : 'popular trending 4K HDR';
        let items: SearchVideoItem[] = [];
        try {
          const yt = await getYt();
          const sr = await yt.search(query, {
            type: 'video',
            prioritize: 'relevance',
          });
          for (const v of sr.videos || []) {
            const mapped = mapRawVideoItem(v);
            if (mapped && !excludeSet.has(mapped.videoId)) items.push(mapped);
            if (items.length >= 24) break;
          }
        } catch {
          // fallback below
        }
        if (items.length === 0) {
          items = (await searchViaExternalProxy(query, 'video', 'relevance')).filter(
            (m) => !excludeSet.has(m.videoId),
          );
        }
        const payload: PersonalizedFeedResponse = {
          items,
          basisTopics: ['急上昇', '4K HDR'],
          basisAuthors: [],
          algorithmSummary: '視聴履歴がまだないため、人気・高画質トレンドを基準に表示しています。動画を視聴すると好みに合わせてリアルタイムに最適化されます。',
        };
        res.setHeader('X-Cache', 'DYNAMIC');
        res.setHeader('X-Upstream-Node', 'kuro-algo-coldstart');
        res.json(payload);
        return;
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'Recommendation failed' });
        return;
      }
    }

    const now = Date.now();
    const topicWeights = new Map<string, number>();
    const authorWeights = new Map<string, number>();

    const STOP_WORDS = new Set([
      'official', 'video', 'music', '4k', 'hdr', '60fps', 'full', 'live', 'mv', 'pv',
      'shorts', 'youtube', '公式', '動画', '高画質', '最新', '日本', 'japan', 'the', 'and', 'for', 'with',
    ]);

    const extractTokens = (text: string): string[] => {
      return text
        .toLowerCase()
        .replace(/[【】「」『』()\[\]|・/\\!?！？,.:;"']/g, ' ')
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
    };

    for (const h of history) {
      const ageHours = Math.max(0, (now - (h.watchedAt || now)) / 3_600_000);
      const decay = Math.exp(-ageHours / 72);
      const w = decay * Math.min(3, h.watchCount || 1);

      if (h.author) {
        authorWeights.set(h.author, (authorWeights.get(h.author) || 0) + w * 1.4);
      }

      const tokens = [...(h.keywords || []), ...extractTokens(h.title || '')];
      for (const tok of tokens) {
        const clean = tok.toLowerCase().trim();
        if (clean.length >= 2 && !STOP_WORDS.has(clean)) {
          topicWeights.set(clean, (topicWeights.get(clean) || 0) + w);
        }
      }
    }

    const sortedTopics = [...topicWeights.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t)
      .slice(0, 4);
    const sortedAuthors = [...authorWeights.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([a]) => a)
      .slice(0, 2);

    try {
      const yt = await getYt();
      const mostRecentId = history[0]?.videoId;
      const queries: string[] = [];
      if (sortedTopics[0]) queries.push(sortedTopics[0]);
      if (sortedTopics[1]) queries.push(sortedTopics[1]);
      if (sortedAuthors[0] && sortedAuthors[0] !== 'YouTube Creator') {
        queries.push(sortedAuthors[0]);
      }

      const [watchNextRes, ...searchResults] = await Promise.allSettled([
        mostRecentId ? yt.getInfo(mostRecentId) : Promise.resolve(null),
        ...queries.slice(0, 3).map((q) =>
          yt.search(q, { type: 'video', prioritize: 'relevance' }),
        ),
      ]);

      const candidateMap = new Map<string, { item: SearchVideoItem; score: number }>();

      const addCandidate = (mapped: SearchVideoItem, watchNextBoost: number) => {
        if (!mapped || excludeSet.has(mapped.videoId)) return;
        const tokens = extractTokens(`${mapped.title} ${mapped.description}`);
        let topicScore = 0;
        for (const tok of tokens) {
          topicScore += topicWeights.get(tok) || 0;
        }
        const authorScore = authorWeights.get(mapped.author) || 0;
        const qualityBoost = mapped.is4k ? 0.6 : 0;
        const popBoost = Math.log10((mapped.viewCount || 0) + 10) * 0.25;
        const totalScore = topicScore * 2.2 + authorScore * 2.0 + watchNextBoost + qualityBoost + popBoost;

        const existing = candidateMap.get(mapped.videoId);
        if (existing) {
          existing.score = Math.max(existing.score, totalScore) + 0.8;
        } else {
          candidateMap.set(mapped.videoId, { item: mapped, score: totalScore });
        }
      };

      if (watchNextRes.status === 'fulfilled' && watchNextRes.value) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawNext = Array.isArray((watchNextRes.value as any)?.watch_next_feed)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? (watchNextRes.value as any).watch_next_feed
          : [];
        for (const v of rawNext) {
          const mapped = mapRawVideoItem(v);
          if (mapped) addCandidate(mapped, 2.5);
        }
      }

      for (const sr of searchResults) {
        if (sr.status === 'fulfilled') {
          for (const v of sr.value?.videos || []) {
            const mapped = mapRawVideoItem(v);
            if (mapped) addCandidate(mapped, 0.5);
          }
        }
      }

      // MMR-style Channel Diversity Re-ranking
      const pool = [...candidateMap.values()];
      const channelCounts = new Map<string, number>();
      const ranked: SearchVideoItem[] = [];

      while (pool.length > 0 && ranked.length < 24) {
        let bestIdx = 0;
        let bestAdjusted = -Infinity;
        for (let i = 0; i < pool.length; i++) {
          const c = pool[i];
          const chCount = channelCounts.get(c.item.author) || 0;
          const adjusted = c.score - chCount * 2.2;
          if (adjusted > bestAdjusted) {
            bestAdjusted = adjusted;
            bestIdx = i;
          }
        }
        const [picked] = pool.splice(bestIdx, 1);
        channelCounts.set(picked.item.author, (channelCounts.get(picked.item.author) || 0) + 1);
        ranked.push(picked.item);
      }

      const payload: PersonalizedFeedResponse = {
        items: ranked,
        basisTopics: sortedTopics.slice(0, 3),
        basisAuthors: sortedAuthors,
        algorithmSummary: `視聴履歴 (${history.length}件) のトピック重み付け・チャンネル親和性・共起関連度から ${ranked.length} 本を最適化しました。`,
      };
      res.setHeader('X-Cache', 'DYNAMIC');
      res.setHeader('X-Upstream-Node', 'kuro-recommendation-engine');
      res.json(payload);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'パーソナライズ推薦の生成に失敗しました' });
    }
  });

  // 13. GET & POST /api/v1/config/stream (Runtime Cookie, Outbound Proxy & Custom Upstream configuration)
  app.get('/api/v1/config/stream', async (_req, res) => {
    const yt = await getYt().catch(() => null);
    const status: StreamConfigStatus = {
      hasCookies: Boolean(streamConfig.cookies),
      customUpstreamUrl: streamConfig.customUpstreamUrl,
      outboundProxyUrl: streamConfig.outboundProxyUrl,
      oauthAuthorized: Boolean(yt?.session?.logged_in || oauthState.status === 'authorized'),
      poTokenReady: minterReady,
      ffmpegAvailable: FFMPEG_AVAILABLE,
    };
    res.setHeader('X-Cache', 'DYNAMIC');
    res.setHeader('X-Upstream-Node', 'kurostream-edge');
    res.json(status);
  });

  app.post('/api/v1/config/stream', async (req, res) => {
    const body = req.body as { cookies?: string; customUpstreamUrl?: string; outboundProxyUrl?: string };
    if (typeof body?.cookies === 'string') {
      streamConfig.cookies = body.cookies.trim();
    }
    if (typeof body?.customUpstreamUrl === 'string') {
      streamConfig.customUpstreamUrl = body.customUpstreamUrl.trim().replace(/\/+$/, '');
    }
    if (typeof body?.outboundProxyUrl === 'string') {
      streamConfig.outboundProxyUrl = body.outboundProxyUrl.trim();
    }
    resetYtSession();
    const yt = await getYt().catch(() => null);

    const status: StreamConfigStatus = {
      hasCookies: Boolean(streamConfig.cookies),
      customUpstreamUrl: streamConfig.customUpstreamUrl,
      outboundProxyUrl: streamConfig.outboundProxyUrl,
      oauthAuthorized: Boolean(yt?.session?.logged_in || oauthState.status === 'authorized'),
      poTokenReady: minterReady,
      ffmpegAvailable: FFMPEG_AVAILABLE,
    };
    res.setHeader('X-Cache', 'PURGED');
    res.setHeader('X-Upstream-Node', 'kurostream-edge');
    res.json(status);
  });

  // 13b. YouTube TV Device Code OAuth Endpoints (1-click server-side Bot check unblock)
  app.get('/api/v1/auth/youtube/status', async (_req, res) => {
    const yt = await getYt().catch(() => null);
    if (yt?.session?.logged_in) {
      oauthState = { status: 'authorized' };
    }
    res.setHeader('X-Cache', 'DYNAMIC');
    res.setHeader('X-Upstream-Node', 'kuro-oauth');
    res.json(oauthState);
  });

  app.post('/api/v1/auth/youtube/start', async (_req, res) => {
    try {
      const yt = await getYt();
      if (yt.session.logged_in) {
        oauthState = { status: 'authorized' };
        res.json(oauthState);
        return;
      }

      const pendingResult = await new Promise<YouTubeAuthStatus>((resolve) => {
        let settled = false;
        const done = (st: YouTubeAuthStatus) => {
          if (settled) return;
          settled = true;
          resolve(st);
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onPending = (data: any) => {
          const st: YouTubeAuthStatus = {
            status: 'pending',
            userCode: String(data?.user_code || ''),
            verificationUrl: String(data?.verification_url || 'https://www.google.com/device'),
            expiresAt: Date.now() + (Number(data?.expires_in) || 1800) * 1000,
          };
          oauthState = st;
          done(st);
        };

        const onAuth = () => {
          oauthState = { status: 'authorized' };
          done(oauthState);
        };

        const onErr = (err: unknown) => {
          const st: YouTubeAuthStatus = {
            status: 'error',
            error: err instanceof Error ? err.message : 'デバイスコード生成に失敗しました',
          };
          oauthState = st;
          done(st);
        };

        yt.session.once('auth-pending', onPending);
        yt.session.once('auth', onAuth);
        yt.session.once('auth-error', onErr);

        yt.session.signIn().catch((err) => onErr(err));

        setTimeout(() => {
          done(oauthState);
        }, 6000);
      });

      res.setHeader('X-Cache', 'DYNAMIC');
      res.setHeader('X-Upstream-Node', 'kuro-oauth');
      res.json(pendingResult);
    } catch (err) {
      res.status(502).json({
        status: 'error',
        error: err instanceof Error ? err.message : 'YouTube 認証の開始に失敗しました',
      });
    }
  });

  app.post('/api/v1/auth/youtube/logout', async (_req, res) => {
    try {
      const yt = await getYt().catch(() => null);
      if (yt?.session?.logged_in) {
        await yt.session.signOut().catch(() => {});
      }
      clearSavedOAuthTokens();
      oauthState = { status: 'idle' };
      resetYtSession();
      getYt().catch(() => {});
      res.json(oauthState);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'ログアウト失敗' });
    }
  });

  // 14. 独自 API 1: GET /api/kuro/4k-stream/:id (4K最適ストリーム自動解決 & バンドルAPI)
  app.get('/api/kuro/4k-stream/:id', async (req, res) => {
    const videoId = String(req.params.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).json({ error: '不正な動画IDです' });
      return;
    }

    const cacheKey = `kuro4k:${videoId}`;
    const refresh = req.query.refresh === 'true';
    if (!refresh) {
      const cached = cacheGet<Kuro4kStreamResponse>(cacheKey);
      if (cached.hit && !cached.stale && cached.data) {
        metrics.hits += 1;
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Upstream-Node', 'kuro-4k-resolver');
        res.json(cached.data);
        return;
      }
    }

    metrics.misses += 1;
    try {
      const vCached = cacheGet<VideoResponse>(`video:${videoId}`);
      const video = vCached.hit && !vCached.stale && vCached.data
        ? vCached.data
        : await fetchVideoFull(videoId);

      if (!vCached.hit || vCached.stale) {
        cacheSet(`video:${videoId}`, video, 300_000, video.upstreamSource || 'innertube-edge');
      }

      const vTracks = video.adaptiveFormats
        .filter((f) => f.type.startsWith('video/'))
        .sort((a, b) => {
          const rA = parseInt(a.qualityLabel || '0', 10) || 0;
          const rB = parseInt(b.qualityLabel || '0', 10) || 0;
          if (rB !== rA) return rB - rA;
          return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
        });
      const aTracks = video.adaptiveFormats
        .filter((f) => f.type.startsWith('audio/'))
        .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));

      const bestV = vTracks[0] || null;
      const bestA = aTracks[0] || null;
      const bestProg = video.formatStreams[0] || null;

      const recommendedEngine: Kuro4kStreamResponse['recommendedEngine'] =
        bestV && bestA ? 'sync' : bestProg ? 'progressive' : 'none';

      const payload: Kuro4kStreamResponse = {
        videoId: video.videoId,
        title: video.title,
        author: video.author,
        lengthSeconds: video.lengthSeconds,
        maxQuality: bestV?.qualityLabel || bestProg?.qualityLabel || video.maxResolution || '1080p',
        isHdrOr60fps: Boolean(bestV?.fps && bestV.fps >= 50) || /\b(hdr|60fps|4k|2160p)\b/i.test(video.title),
        recommendedEngine,
        bestVideo: bestV
          ? {
              itag: bestV.itag,
              qualityLabel: bestV.qualityLabel || bestV.resolution,
              container: bestV.container,
              encoding: bestV.encoding,
              bitrateKbps: Math.round((Number(bestV.bitrate) || 0) / 1000),
              fps: bestV.fps,
              proxyUrl: `/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(bestV.itag)}`,
            }
          : null,
        bestAudio: bestA
          ? {
              itag: bestA.itag,
              container: bestA.container,
              encoding: bestA.encoding,
              bitrateKbps: Math.round((Number(bestA.bitrate) || 0) / 1000),
              proxyUrl: `/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(bestA.itag)}`,
            }
          : null,
        muxUrl:
          bestV && bestA && FFMPEG_AVAILABLE
            ? `/api/v1/stream/mux?id=${encodeURIComponent(videoId)}&v=${encodeURIComponent(bestV.itag)}&a=${encodeURIComponent(bestA.itag)}`
            : null,
        progressiveUrl: bestProg
          ? `/latest_version?id=${encodeURIComponent(videoId)}&itag=${encodeURIComponent(bestProg.itag)}`
          : null,
        thumbnailMaxres: `/api/v1/thumbnail/${videoId}/maxresdefault`,
        directStreamAvailable: Boolean(video.directStreamAvailable),
        streamErrorReason: video.streamErrorReason,
      };

      cacheSet(cacheKey, payload, 300_000, 'kuro-4k-resolver');
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Upstream-Node', 'kuro-4k-resolver');
      res.json(payload);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : '4Kストリーム解決に失敗しました' });
    }
  });

  // 15. 独自 API 2: POST /api/kuro/batch-meta (超高速・並列バッチ動画メタデータ一括取得 API)
  app.post('/api/kuro/batch-meta', async (req, res) => {
    const t0 = performance.now();
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids: string[] = [...new Set<string>(rawIds.map((x: unknown) => String(x).trim()))]
      .filter((id) => /^[a-zA-Z0-9_-]{6,20}$/.test(id))
      .slice(0, 20);

    if (ids.length === 0) {
      res.status(400).json({ error: 'ids 配列に有効な動画IDを1〜20件指定してください' });
      return;
    }

    const items = await Promise.all(
      ids.map(async (id): Promise<KuroBatchMetaItem> => {
        const cached = cacheGet<VideoResponse>(`video:${id}`);
        if (cached.hit && !cached.stale && cached.data) {
          metrics.hits += 1;
          const d = cached.data;
          return {
            videoId: id,
            ok: true,
            title: d.title,
            author: d.author,
            authorId: d.authorId,
            lengthSeconds: d.lengthSeconds,
            viewCountText: d.viewCountText,
            maxResolution: d.maxResolution,
            thumbnailUrl: `/api/v1/thumbnail/${id}/maxresdefault`,
          };
        }
        metrics.misses += 1;
        try {
          const d = await fetchVideoFull(id);
          cacheSet(`video:${id}`, d, 300_000, d.upstreamSource || 'innertube-edge');
          return {
            videoId: id,
            ok: true,
            title: d.title,
            author: d.author,
            authorId: d.authorId,
            lengthSeconds: d.lengthSeconds,
            viewCountText: d.viewCountText,
            maxResolution: d.maxResolution,
            thumbnailUrl: `/api/v1/thumbnail/${id}/maxresdefault`,
          };
        } catch (err) {
          return {
            videoId: id,
            ok: false,
            error: err instanceof Error ? err.message : '取得失敗',
          };
        }
      }),
    );

    const payload: KuroBatchMetaResponse = {
      requestedCount: ids.length,
      succeededCount: items.filter((i) => i.ok).length,
      elapsedMs: Math.round((performance.now() - t0) * 100) / 100,
      items,
    };
    res.setHeader('X-Cache', 'BATCH');
    res.setHeader('X-Upstream-Node', 'kuro-batch-engine');
    res.json(payload);
  });

  // -------------------------------------------------------------------------
  // 16. 10サーバークラスタ (安定型3 / 高速型3 / 高画質型3 / 復旧探索型1 : 3001-3010実稼働)
  // -------------------------------------------------------------------------
  // 独自 API 4: GET /api/kuro/cluster-nodes (10サーバーの実ソケット死活・応答速度・処理件数監視)
  app.get('/api/kuro/cluster-nodes', async (req, res) => {
    const refresh = req.query.refresh === 'true';
    const cacheKey = 'kuro:cluster-nodes:v2';
    if (!refresh) {
      const cached = cacheGet<ClusterServerNode[]>(cacheKey);
      if (cached.hit && !cached.stale && cached.data) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Upstream-Node', 'kuro-cluster-supervisor');
        res.json(cached.data);
        return;
      }
    }

    const probed: ClusterServerNode[] = await Promise.all(
      ORIGIN_INSTANCES.map(async (inst): Promise<ClusterServerNode> => {
        const t0 = performance.now();
        try {
          const r = await proxiedFetch(`http://${ORIGIN_HOST}:${inst.port}/health`, {
            headers: { 'x-kuro-origin-token': ORIGIN_AUTH_TOKEN },
            signal: AbortSignal.timeout(2000),
          });
          const latencyMs = Math.max(1, Math.round(performance.now() - t0));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hJson = r.ok ? ((await r.json().catch(() => null)) as any) : null;
          return {
            id: inst.id,
            name: inst.name,
            tier: inst.tier,
            tierLabel: inst.tierLabel,
            endpoint: inst.endpoint,
            protocol: inst.protocol,
            port: inst.port,
            handledRequests:
              typeof hJson?.handledRequests === 'number'
                ? hJson.handledRequests
                : instanceRequestCounts.get(inst.port) || 0,
            status: r.ok ? (latencyMs < 1100 ? 'online' : 'degraded') : 'degraded',
            latencyMs,
            capabilities: inst.capabilities,
            priority: inst.priority,
          };
        } catch {
          return {
            id: inst.id,
            name: inst.name,
            tier: inst.tier,
            tierLabel: inst.tierLabel,
            endpoint: inst.endpoint,
            protocol: inst.protocol,
            port: inst.port,
            handledRequests: instanceRequestCounts.get(inst.port) || 0,
            status: 'offline',
            latencyMs: null,
            capabilities: inst.capabilities,
            priority: inst.priority,
          };
        }
      }),
    );

    cacheSet(cacheKey, probed, 15_000, 'kuro-cluster-supervisor');
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Upstream-Node', 'kuro-cluster-supervisor');
    res.json(probed);
  });

  // 独自 API 5: GET /api/kuro/edu-embed/:id (Google Classroom & Kahoot! 埋め込み解決 API)
  app.get('/api/kuro/edu-embed/:id', async (req, res) => {
    const videoId = String(req.params.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).json({ error: '不正な動画IDです' });
      return;
    }

    const pubOriginHdr = String(req.headers['x-kuro-public-origin'] || '').trim();
    const reqOrigin =
      typeof req.headers.origin === 'string' && req.headers.origin.startsWith('http')
        ? req.headers.origin
        : pubOriginHdr.startsWith('http')
          ? pubOriginHdr
          : undefined;
    const lang = String(req.query.lang || 'ja').slice(0, 10) || 'ja';

    const cacheKey = `kuro:edu:${videoId}:${lang}:${reqOrigin || 'default'}`;
    const cached = cacheGet<EduEmbedConfig>(cacheKey);
    if (cached.hit && !cached.stale && cached.data) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Upstream-Node', 'kuro-edu-gateway');
      res.json(cached.data);
      return;
    }

    let title = `Video ${videoId}`;
    let author = 'YouTube Education';
    let embeddable = true;

    const vidCached = cacheGet<VideoResponse>(`video:${videoId}`);
    if (vidCached.hit && vidCached.data) {
      title = vidCached.data.title;
      author = vidCached.data.author;
    } else {
      try {
        const oe = await proxiedFetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`,
          {
            headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
            signal: AbortSignal.timeout(3000),
          },
        );
        if (oe.ok) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const d = (await oe.json()) as any;
          if (d?.title) title = String(d.title);
          if (d?.author_name) author = String(d.author_name);
          embeddable = true;
        } else if (oe.status === 401 || oe.status === 403 || oe.status === 404) {
          embeddable = false;
        }
      } catch {
        // continue with fallback metadata
      }
    }

    const payload = buildEduEmbedConfig(videoId, title, author, embeddable, lang, reqOrigin);
    cacheSet(cacheKey, payload, 600_000, 'kuro-edu-gateway');
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Upstream-Node', 'kuro-edu-gateway');
    res.json(payload);
  });

  // Helper to get or populate full video metadata
  async function ensureVideoCached(videoId: string, refresh = false): Promise<VideoResponse> {
    if (!refresh) {
      const cached = cacheGet<VideoResponse>(`video:${videoId}`);
      if (cached.hit && !cached.stale && cached.data) return cached.data;
    }
    const fresh = await fetchVideoFull(videoId);
    cacheSet(`video:${videoId}`, fresh, 300_000, fresh.upstreamSource || 'innertube-edge');
    return fresh;
  }

  // -------------------------------------------------------------------------
  // 16b. 5 Dedicated Stream-Capable Servers (/api/server/1..5/health|info|stream)
  // -------------------------------------------------------------------------
  app.get('/api/server/:serverNum/health', (req, res) => {
    const num = Number(req.params.serverNum);
    const inst = ORIGIN_INSTANCES.find((s) => s.serverNumber === num);
    if (!inst) {
      res.status(404).json({ error: 'Server number must be 1 to 5' });
      return;
    }
    res.json({
      ok: true,
      serverNumber: inst.serverNumber,
      id: inst.id,
      name: inst.name,
      port: inst.port,
      tier: inst.tier,
      tierLabel: inst.tierLabel,
      protocol: inst.protocol,
      capabilities: inst.capabilities,
      infoEndpoint: `/api/server/${num}/info/:id`,
      streamEndpoint: `/api/server/${num}/stream/:id`,
      handledRequests: instanceRequestCounts.get(inst.port) || 0,
    });
  });

  app.get('/api/server/:serverNum/info/:id', async (req, res) => {
    const num = Number(req.params.serverNum);
    const videoId = String(req.params.id || '').trim();
    const inst = ORIGIN_INSTANCES.find((s) => s.serverNumber === num);
    if (!inst) {
      res.status(404).json({ error: 'Server number must be 1 to 5' });
      return;
    }
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).json({ error: '不正な動画IDです' });
      return;
    }
    try {
      const video = await ensureVideoCached(videoId, req.query.refresh === 'true');
      const vTracks = video.adaptiveFormats
        .filter((f) => f.type.startsWith('video/'))
        .sort((a, b) => (parseInt(b.qualityLabel || '0', 10) || 0) - (parseInt(a.qualityLabel || '0', 10) || 0));
      const aTracks = video.adaptiveFormats
        .filter((f) => f.type.startsWith('audio/'))
        .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
      const bestV = vTracks[0] || null;
      const bestA = aTracks[0] || null;
      const bestProg = video.formatStreams[0] || null;

      res.setHeader('X-Cache', 'DYNAMIC');
      res.setHeader('X-Upstream-Node', inst.id);
      res.json({
        ok: true,
        serverNumber: inst.serverNumber,
        serverId: inst.id,
        serverName: inst.name,
        port: inst.port,
        tier: inst.tier,
        videoId,
        title: video.title,
        author: video.author,
        lengthSeconds: video.lengthSeconds,
        maxResolution: bestV?.qualityLabel || bestProg?.qualityLabel || video.maxResolution,
        playableStreamUrl: `/api/server/${num}/stream/${encodeURIComponent(videoId)}`,
        mp4Url: `/api/v1/stream/googlevideo/${encodeURIComponent(videoId)}?itag=${encodeURIComponent(bestProg?.itag || '18')}`,
        muxUrl:
          bestV && bestA && FFMPEG_AVAILABLE
            ? `/api/v1/stream/mux?id=${encodeURIComponent(videoId)}&v=${encodeURIComponent(bestV.itag)}&a=${encodeURIComponent(bestA.itag)}`
            : null,
        hlsUrl: `/api/server/3/stream/${encodeURIComponent(videoId)}`,
        directStreamAvailable: Boolean(video.directStreamAvailable),
        formatCount: video.formatStreams.length + video.adaptiveFormats.length,
        formatStreams: video.formatStreams,
        adaptiveFormats: video.adaptiveFormats,
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : '動画ストリーム情報の取得に失敗しました' });
    }
  });

  app.get('/api/server/:serverNum/stream/:id', async (req, res) => {
    const num = Number(req.params.serverNum);
    const videoId = String(req.params.id || '').trim();
    const inst = ORIGIN_INSTANCES.find((s) => s.serverNumber === num);
    if (!inst) {
      res.status(404).json({ error: 'Server number must be 1 to 5' });
      return;
    }
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).json({ error: '不正な動画IDです' });
      return;
    }

    res.setHeader('X-Kuro-Server-Id', inst.id);
    res.setHeader('X-Kuro-Server-Port', String(inst.port));

    try {
      const video = await ensureVideoCached(videoId, req.query.refresh === 'true');
      const requestedItag = String(req.query.itag || '').trim();

      if (num === 3) {
        // Server 3: Adaptive HLS (.m3u8) streaming
        await serveHlsFile(
          videoId,
          'index.m3u8',
          `/api/server/3/hls/${encodeURIComponent(videoId)}`,
          res,
        );
        return;
      }

      if (num === 2 || num === 5) {
        // Server 2 (High Quality 4K/1080p Mux MP4) & Server 5 (Auto Failover Mux -> Progressive MP4)
        const maxH = Number(req.query.maxHeight || req.query.q || (num === 2 ? 2160 : 1080)) || 2160;
        const seekSec = Math.max(0, Number(req.query.t || 0) || 0);
        await streamMuxedMp4Response(videoId, res, {
          maxHeight: maxH,
          seekSec,
          vItag: requestedItag || undefined,
          rangeHeader: req.headers.range,
        });
        return;
      }

      // Server 1 (Ultra-Fast Range MP4) & Server 4 (Ultra-Stable Universal H.264/AAC MP4)
      const progFmt =
        (requestedItag
          ? [...video.formatStreams, ...video.adaptiveFormats].find((f) => f.itag === requestedItag)
          : null) ||
        video.formatStreams.find((f) => f.itag === '18') ||
        video.formatStreams[0] ||
        null;
      const pickedItag = progFmt?.itag || requestedItag || '18';
      const pickedUrl = progFmt?.url || companionStreamUrl(videoId, pickedItag);
      const upstream = await fetchUpstreamMediaWithFailover(videoId, pickedItag, pickedUrl, req.headers.range);

      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
      res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
      res.setHeader('X-Stream-Mode', num === 1 ? 'ultra-fast-range-mp4' : 'ultra-stable-h264-mp4');
      res.setHeader('X-Googlevideo-Itag', pickedItag);
      const cl = upstream.headers.get('content-length');
      const cr = upstream.headers.get('content-range');
      if (cl) res.setHeader('Content-Length', cl);
      if (cr) res.setHeader('Content-Range', cr);
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      res.on('close', () => {
        if (!res.writableEnded) reader.cancel().catch(() => {});
      });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writableEnded) res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'ストリーム配信エラー' });
      }
    }
  });

  app.get('/api/server/:serverNum/hls/:id/:file', async (req, res) => {
    const id = String(req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const file = String(req.params.file || '');
    const num = Number(req.params.serverNum) || 3;
    await serveHlsFile(id, file, `/api/server/${num}/hls/${encodeURIComponent(id)}`, res);
  });

  // 独自 API 6: GET /api/kuro/stable-stream/:id (安定型: 学校端末対応 H.264 MP4 + Server 4 直結)
  app.get('/api/kuro/stable-stream/:id', async (req, res) => {
    const videoId = String(req.params.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).json({ error: '不正な動画IDです' });
      return;
    }
    try {
      const video = await ensureVideoCached(videoId, req.query.refresh === 'true');
      const h264Prog =
        video.formatStreams.find((f) => f.container === 'mp4' && f.itag === '18') ||
        video.formatStreams.find((f) => f.container === 'mp4') ||
        video.formatStreams[0] ||
        null;
      const eduEmbed = video.eduEmbed || buildEduEmbedConfig(videoId, video.title, video.author);

      res.setHeader('X-Cache', 'DYNAMIC');
      res.setHeader('X-Upstream-Node', 'kuro-srv-4');
      res.json({
        tier: 'stable',
        serverId: 'kuro-srv-4',
        videoId,
        title: video.title,
        author: video.author,
        compatibleMp4Url: `/api/server/4/stream/${encodeURIComponent(videoId)}`,
        googlevideoRangeUrl: `/api/v1/stream/googlevideo/${encodeURIComponent(videoId)}?itag=${encodeURIComponent(h264Prog?.itag || '18')}&profile=stable`,
        relayFallbackUrl: video.clientRelayStreams?.[0]?.url || null,
        eduEmbed,
        directStreamAvailable: Boolean(video.directStreamAvailable),
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : '安定型ストリームの取得に失敗しました' });
    }
  });

  // 独自 API 7: GET /api/kuro/fast-stream/:id (高速型: Googlevideo IP秘匿 Range MP4 + Server 1 直結)
  app.get('/api/kuro/fast-stream/:id', async (req, res) => {
    const videoId = String(req.params.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).json({ error: '不正な動画IDです' });
      return;
    }
    try {
      const video = await ensureVideoCached(videoId, req.query.refresh === 'true');
      const bestProg = video.formatStreams[0] || null;
      const bestAdaptive = video.adaptiveFormats.find((f) => f.type.startsWith('video/mp4')) || video.adaptiveFormats[0] || null;
      const targetItag = bestProg?.itag || bestAdaptive?.itag || '18';

      res.setHeader('X-Cache', 'DYNAMIC');
      res.setHeader('X-Upstream-Node', 'kuro-srv-1');
      res.json({
        tier: 'fast',
        serverId: 'kuro-srv-1',
        videoId,
        title: video.title,
        author: video.author,
        googlevideoRelayUrl: `/api/server/1/stream/${encodeURIComponent(videoId)}`,
        directGooglevideoUrl: bestProg?.url || bestAdaptive?.url || companionStreamUrl(videoId, targetItag),
        hlsUrl: `/api/server/3/stream/${encodeURIComponent(videoId)}`,
        eduEmbed: video.eduEmbed || buildEduEmbedConfig(videoId, video.title, video.author),
        directStreamAvailable: Boolean(video.directStreamAvailable),
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : '高速型ストリームの取得に失敗しました' });
    }
  });

  // 独自 API 8: GET /api/kuro/hq-stream/:id (高画質型: 4K60/HDR + FFmpeg MP4結合 + Server 2/3 直結)
  app.get('/api/kuro/hq-stream/:id', async (req, res) => {
    const videoId = String(req.params.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).json({ error: '不正な動画IDです' });
      return;
    }
    try {
      const video = await ensureVideoCached(videoId, req.query.refresh === 'true');
      const vTracks = video.adaptiveFormats
        .filter((f) => f.type.startsWith('video/'))
        .sort((a, b) => (parseInt(b.qualityLabel || '0', 10) || 0) - (parseInt(a.qualityLabel || '0', 10) || 0));
      const aTracks = video.adaptiveFormats
        .filter((f) => f.type.startsWith('audio/'))
        .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));

      const bestV = vTracks[0] || null;
      const bestA = aTracks[0] || null;

      res.setHeader('X-Cache', 'DYNAMIC');
      res.setHeader('X-Upstream-Node', 'kuro-srv-2');
      res.json({
        tier: 'hq',
        serverId: 'kuro-srv-2',
        videoId,
        title: video.title,
        maxQuality: bestV?.qualityLabel || video.maxResolution || '1080p',
        muxUrl:
          bestV && bestA && FFMPEG_AVAILABLE
            ? `/api/server/2/stream/${encodeURIComponent(videoId)}`
            : `/api/v1/stream/mux?id=${encodeURIComponent(videoId)}`,
        hlsUrl: `/api/server/3/stream/${encodeURIComponent(videoId)}`,
        videoItag: bestV?.itag || null,
        audioItag: bestA?.itag || null,
        directStreamAvailable: Boolean(video.directStreamAvailable),
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : '高画質型ストリームの取得に失敗しました' });
    }
  });

  // 独自 API 9: GET /api/kuro/auto-fallback/:id (5ストリームサーバー環境判定付き自動フォールバック統合 API)
  app.get('/api/kuro/auto-fallback/:id', async (req, res) => {
    const videoId = String(req.params.id || '').trim();
    const profile = String(req.query.profile || 'auto');
    const downlink = Number(req.query.downlink || 20);
    const maxH = Number(req.query.maxHeight || 2160);

    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).json({ error: '不正な動画IDです' });
      return;
    }

    const attempts: FallbackAttempt[] = [];
    const tStart = performance.now();
    const video = await ensureVideoCached(videoId, req.query.refresh === 'true').catch(() => null);

    const vTracks = (video?.adaptiveFormats || [])
      .filter((f) => f.type.startsWith('video/'))
      .sort((a, b) => (parseInt(b.qualityLabel || '0', 10) || 0) - (parseInt(a.qualityLabel || '0', 10) || 0));
    const aTracks = (video?.adaptiveFormats || [])
      .filter((f) => f.type.startsWith('audio/'))
      .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
    const bestProg = video?.formatStreams?.[0] || null;
    const capV = vTracks.find((f) => (parseInt(f.qualityLabel || '0', 10) || 0) <= maxH) || vTracks[0] || null;
    const bestA = aTracks[0] || null;

    const muxUrl =
      capV && bestA && FFMPEG_AVAILABLE
        ? `/api/server/2/stream/${encodeURIComponent(videoId)}?maxHeight=${encodeURIComponent(String(maxH))}`
        : null;
    const gvUrl = `/api/server/1/stream/${encodeURIComponent(videoId)}`;
    const hlsUrl = `/api/server/3/stream/${encodeURIComponent(videoId)}`;
    const stableUrl = `/api/server/4/stream/${encodeURIComponent(videoId)}`;
    const eduEmbed = video?.eduEmbed || buildEduEmbedConfig(videoId, video?.title || '', video?.author || '');

    let selectedTier: ServerTier = 'fast';
    let selectedServer = 'kuro-srv-1';
    let selectedEngine: AutoFallbackStreamResponse['selectedEngine'] = 'googlevideo';
    let streamUrl: string | null = gvUrl;

    const tryHq = () => {
      const ms = Math.round((performance.now() - tStart) * 100) / 100;
      if (muxUrl) {
        attempts.push({ serverId: 'kuro-srv-2', serverName: 'Stream Server 2 (4K/1080p FFmpeg Mux :3002)', tier: 'hq', ok: true, latencyMs: ms, detail: `${capV?.qualityLabel || 'HD'} MP4 Mux 解決` });
        selectedTier = 'hq';
        selectedServer = 'kuro-srv-2';
        selectedEngine = 'mux';
        streamUrl = muxUrl;
        return true;
      }
      if (hlsUrl) {
        attempts.push({ serverId: 'kuro-srv-3', serverName: 'Stream Server 3 (Adaptive HLS :3003)', tier: 'hq', ok: true, latencyMs: ms, detail: 'HLS .m3u8 解決' });
        selectedTier = 'hq';
        selectedServer = 'kuro-srv-3';
        selectedEngine = 'hls';
        streamUrl = hlsUrl;
        return true;
      }
      return false;
    };

    const tryFast = () => {
      const ms = Math.round((performance.now() - tStart) * 100) / 100;
      if (video?.directStreamAvailable || bestProg) {
        attempts.push({ serverId: 'kuro-srv-1', serverName: 'Stream Server 1 (超高速 Range MP4 :3001)', tier: 'fast', ok: true, latencyMs: ms, detail: `itag=${bestProg?.itag || '18'} 206 Range配信準備完了` });
        selectedTier = 'fast';
        selectedServer = 'kuro-srv-1';
        selectedEngine = 'googlevideo';
        streamUrl = gvUrl;
        return true;
      }
      return false;
    };

    const tryStable = () => {
      const ms = Math.round((performance.now() - tStart) * 100) / 100;
      attempts.push({ serverId: 'kuro-srv-4', serverName: 'Stream Server 4 (超安定 H.264/AAC MP4 :3004)', tier: 'stable', ok: true, latencyMs: ms, detail: '学校端末互換 H.264/AAC MP4 + 統合フォールバック' });
      selectedTier = 'stable';
      selectedServer = 'kuro-srv-4';
      selectedEngine = 'progressive';
      streamUrl = stableUrl;
      return true;
    };

    if (profile === 'hq') {
      if (!tryHq() && !tryFast()) tryStable();
    } else if (profile === 'stable' || downlink < 5) {
      tryStable();
    } else if (profile === 'fast') {
      if (!tryFast() && !tryHq()) tryStable();
    } else {
      const preferHq = downlink >= 12 && maxH >= 1080;
      if (preferHq) {
        if (!tryHq() && !tryFast()) tryStable();
      } else {
        if (!tryFast() && !tryHq()) tryStable();
      }
    }

    const payload: AutoFallbackStreamResponse = {
      videoId,
      title: video?.title || eduEmbed.title,
      author: video?.author || eduEmbed.author,
      lengthSeconds: video?.lengthSeconds || 0,
      selectedTier,
      selectedServer,
      selectedEngine,
      streamUrl,
      hlsUrl,
      muxUrl,
      progressiveUrl: gvUrl,
      eduEmbed,
      attempts,
      maxQuality: capV?.qualityLabel || bestProg?.qualityLabel || video?.maxResolution || '1080p',
    };

    res.setHeader('X-Cache', 'DYNAMIC');
    res.setHeader('X-Upstream-Node', selectedServer);
    res.json(payload);
  });

  // -------------------------------------------------------------------------
  // 17. High-Performance 2-Stage Live Server Discovery & Auto-Recovery Engine
  //     (10-Instance Cluster + External Invidious + Zernio + Piped)
  // -------------------------------------------------------------------------
  async function probeHttpLiveness(
    url: string,
    headers: Record<string, string> = {},
    timeoutMs = 2400,
  ): Promise<{ ok: boolean; statusCode: number | null; latencyMs: number | null; version?: string }> {
    const t0 = performance.now();
    try {
      const r = await proxiedFetch(url, {
        headers: { 'User-Agent': PRIVACY_USER_AGENTS[0], ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = Math.max(1, Math.round(performance.now() - t0));
      let version: string | undefined;
      if (url.endsWith('/api/v1/stats') && r.ok) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const json = (await r.json()) as any;
          if (json?.software?.version) version = String(json.software.version);
        } catch {
          // ignore non-json
        }
      }
      return {
        ok: r.status >= 200 && r.status < 400,
        statusCode: r.status,
        latencyMs,
        version,
      };
    } catch {
      return { ok: false, statusCode: null, latencyMs: null };
    }
  }

  // Stage-2 verification: verify node can actually extract playable stream manifests (cached 120s)
  async function verifyNodeStreamExtraction(
    baseUrl: string,
    kind: 'invidious' | 'piped' | 'zernio',
  ): Promise<boolean> {
    const clean = baseUrl.replace(/\/+$/, '');
    const cacheKey = `node:stream-verify:${clean}`;
    const cached = cacheGet<boolean>(cacheKey);
    if (cached.hit && !cached.stale && typeof cached.data === 'boolean') {
      return cached.data;
    }

    const testVid = 'aqz-KE-bpKQ';
    try {
      if (kind === 'invidious') {
        const r = await proxiedFetch(`${clean}/api/v1/videos/${testVid}`, {
          headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
          signal: AbortSignal.timeout(2400),
        });
        if (!r.ok) {
          cacheSet(cacheKey, false, 120_000, 'stage2');
          return false;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = (await r.json()) as any;
        const ok = Boolean((d?.formatStreams?.length || 0) > 0 || (d?.adaptiveFormats?.length || 0) > 0 || d?.hlsUrl);
        cacheSet(cacheKey, ok, 120_000, 'stage2');
        return ok;
      }

      // Piped or Zernio
      let r = await proxiedFetch(`${clean}/streams/${testVid}`, {
        headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
        signal: AbortSignal.timeout(2400),
      });
      if (!r.ok && kind === 'zernio') {
        r = await proxiedFetch(`${clean}/api/v1/videos/${testVid}`, {
          headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
          signal: AbortSignal.timeout(2400),
        });
      }
      if (!r.ok) {
        cacheSet(cacheKey, false, 120_000, 'stage2');
        return false;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = (await r.json()) as any;
      const ok = Boolean(
        (d?.videoStreams?.length || 0) > 0 ||
          (d?.audioStreams?.length || 0) > 0 ||
          (d?.formatStreams?.length || 0) > 0 ||
          (d?.adaptiveFormats?.length || 0) > 0 ||
          d?.hls ||
          d?.hlsUrl,
      );
      cacheSet(cacheKey, ok, 120_000, 'stage2');
      return ok;
    } catch {
      cacheSet(cacheKey, false, 90_000, 'stage2');
      return false;
    }
  }

  async function buildLiveServersSnapshot(
    customInvidiousUrl?: string,
    customZernioUrl?: string,
  ): Promise<LiveServersResponse> {
    const checkedAt = new Date().toISOString();
    const pools = await discoverDynamicExternalPools(customInvidiousUrl, customZernioUrl);

    const [clusterProbes, invProbes, zernioProbes, pipedProbes] = await Promise.all([
      // Probe all 10 live isolated origin HTTP instances (127.0.0.1:3001 - 3010)
      Promise.all(
        ORIGIN_INSTANCES.map(async (inst): Promise<LiveServerCheckItem> => {
          const probe = await probeHttpLiveness(
            `http://${ORIGIN_HOST}:${inst.port}/health`,
            { 'x-kuro-origin-token': ORIGIN_AUTH_TOKEN },
            1800,
          );
          const alive: LiveServerCheckItem['alive'] =
            probe.statusCode === null
              ? 'dead'
              : probe.ok
                ? (probe.latencyMs ?? 0) < 1200
                  ? 'alive'
                  : 'degraded'
                : 'degraded';
          return {
            id: inst.id,
            name: inst.name,
            category: 'self-cluster',
            categoryLabel: `5ストリームサーバー (${inst.tierLabel})`,
            url: `${inst.endpoint} (:${inst.port})`,
            region: 'JP-Edge',
            statusCode: probe.statusCode,
            alive,
            latencyMs: probe.latencyMs,
            cors: true,
            supportsStreams: true,
            streamVerified: alive !== 'dead',
            reliabilityScore: alive === 'alive' ? 100 : alive === 'degraded' ? 75 : 0,
            checkedAt,
            note: `${inst.capabilities.join(' · ')} · 処理 ${instanceRequestCounts.get(inst.port) || 0}件`,
          };
        }),
      ),

      // Top 20 Invidious candidates with Stage-2 stream extraction verification
      Promise.all(
        pools.invidious.slice(0, 20).map(async (node, idx): Promise<LiveServerCheckItem> => {
          const probe = await probeHttpLiveness(`${node.uri}/api/v1/stats`, {}, 2300);
          let streamVerified = false;
          if (probe.ok) {
            streamVerified = await verifyNodeStreamExtraction(node.uri, 'invidious');
          }
          const alive: LiveServerCheckItem['alive'] =
            probe.statusCode === null
              ? 'dead'
              : probe.ok
                ? (probe.latencyMs ?? 0) < 1500
                  ? 'alive'
                  : 'degraded'
                : 'dead';
          recordExternalNodeOutcome(
            node.uri,
            'invidious',
            alive !== 'dead',
            streamVerified,
            probe.latencyMs ?? 4000,
            probe.statusCode,
            { region: node.region, version: probe.version, cors: node.cors },
          );
          const rec = externalNodeRegistry.get(node.uri);
          return {
            id: `inv-${idx}-${node.domain}`,
            name: `Invidious · ${node.domain}`,
            category: 'invidious',
            categoryLabel: '外部 Invidious',
            url: node.uri,
            region: node.region,
            version: probe.version,
            statusCode: probe.statusCode,
            alive,
            latencyMs: probe.latencyMs,
            cors: node.cors,
            supportsStreams: alive !== 'dead',
            streamVerified,
            reliabilityScore: rec?.score ?? (alive === 'alive' ? 70 : 0),
            checkedAt,
            note: streamVerified
              ? 'API疎通 + ストリーム実抽出検証OK'
              : alive === 'alive'
                ? 'API疎通正常 (軽量検証)'
                : alive === 'degraded'
                  ? '高遅延または制限応答'
                  : '応答なし / 停止中',
          };
        }),
      ),

      // Zernio endpoints (multi-path probe)
      Promise.all(
        pools.zernio.map(async (z): Promise<LiveServerCheckItem> => {
          const probeTargets = z.id === 'zernio-custom'
            ? [`${z.url}/v1/health`, `${z.url}/api/v1/stats`, `${z.url}/trending?region=JP`, z.url]
            : z.id === 'zernio-api'
              ? [`${z.url}/v1/health`, z.url]
              : [z.url];

          let bestProbe = await probeHttpLiveness(probeTargets[0], {}, 2300);
          for (let i = 1; i < probeTargets.length && !bestProbe.ok && bestProbe.statusCode !== 401 && bestProbe.statusCode !== 403; i++) {
            bestProbe = await probeHttpLiveness(probeTargets[i], {}, 2200);
          }

          let streamVerified = false;
          if (z.id === 'zernio-custom' && (bestProbe.ok || bestProbe.statusCode === 401)) {
            streamVerified = await verifyNodeStreamExtraction(z.url, 'zernio');
          }

          const isUp = bestProbe.ok || bestProbe.statusCode === 401 || bestProbe.statusCode === 403;
          const alive: LiveServerCheckItem['alive'] =
            bestProbe.statusCode === null
              ? 'dead'
              : isUp
                ? (bestProbe.latencyMs ?? 0) < 1500
                  ? 'alive'
                  : 'degraded'
                : 'dead';

          recordExternalNodeOutcome(
            z.url,
            'zernio',
            isUp,
            streamVerified,
            bestProbe.latencyMs ?? 4000,
            bestProbe.statusCode,
            { region: z.region, cors: true },
          );
          const rec = externalNodeRegistry.get(z.url);
          return {
            id: z.id,
            name: z.name,
            category: 'zernio',
            categoryLabel: 'Zernio サーバー',
            url: z.url,
            region: z.region,
            statusCode: bestProbe.statusCode,
            alive,
            latencyMs: bestProbe.latencyMs,
            cors: true,
            supportsStreams: z.id === 'zernio-custom' && isUp,
            streamVerified,
            reliabilityScore: rec?.score ?? (isUp ? 60 : 0),
            checkedAt,
            note: streamVerified
              ? 'Zernio ストリーム抽出検証OK'
              : bestProbe.statusCode === 401 || bestProbe.statusCode === 403
                ? 'サーバー生存 (API認証ゲート稼働中)'
                : alive === 'alive'
                  ? 'オンライン稼働中'
                  : '接続不可 / 停止中',
          };
        }),
      ),

      // Top 12 Piped candidates with Stage-2 stream extraction verification
      Promise.all(
        pools.piped.slice(0, 12).map(async (p, idx): Promise<LiveServerCheckItem> => {
          const probe = await probeHttpLiveness(`${p.url}/trending?region=JP`, {}, 2300);
          let streamVerified = false;
          if (probe.ok) {
            streamVerified = await verifyNodeStreamExtraction(p.url, 'piped');
          }
          const alive: LiveServerCheckItem['alive'] =
            probe.statusCode === null
              ? 'dead'
              : probe.ok
                ? (probe.latencyMs ?? 0) < 1500
                  ? 'alive'
                  : 'degraded'
                : 'dead';
          recordExternalNodeOutcome(
            p.url,
            'piped',
            alive !== 'dead',
            streamVerified,
            probe.latencyMs ?? 4000,
            probe.statusCode,
            { region: p.region, cors: true },
          );
          const rec = externalNodeRegistry.get(p.url);
          return {
            id: `piped-${idx}`,
            name: p.name,
            category: 'piped',
            categoryLabel: '外部リレー (Piped)',
            url: p.url,
            region: p.region,
            statusCode: probe.statusCode,
            alive,
            latencyMs: probe.latencyMs,
            cors: true,
            supportsStreams: alive !== 'dead',
            streamVerified,
            reliabilityScore: rec?.score ?? (alive === 'alive' ? 70 : 0),
            checkedAt,
            note: streamVerified
              ? 'Piped ストリーム実抽出検証OK'
              : alive === 'alive'
                ? 'ストリーム解決可'
                : '応答エラー / 停止',
          };
        }),
      ),
    ]);

    // Sort external categories so verified & fastest live nodes appear first
    const sortByHealth = (a: LiveServerCheckItem, b: LiveServerCheckItem) => {
      const sa = (a.streamVerified ? 1000 : 0) + (a.alive === 'alive' ? 300 : a.alive === 'degraded' ? 100 : 0) + (a.reliabilityScore ?? 0);
      const sb = (b.streamVerified ? 1000 : 0) + (b.alive === 'alive' ? 300 : b.alive === 'degraded' ? 100 : 0) + (b.reliabilityScore ?? 0);
      if (sb !== sa) return sb - sa;
      return (a.latencyMs ?? 9999) - (b.latencyMs ?? 9999);
    };

    invProbes.sort(sortByHealth);
    zernioProbes.sort(sortByHealth);
    pipedProbes.sort(sortByHealth);

    const servers = [...clusterProbes, ...invProbes, ...zernioProbes, ...pipedProbes];
    return {
      checkedAt,
      summary: {
        total: servers.length,
        alive: servers.filter((s) => s.alive === 'alive').length,
        degraded: servers.filter((s) => s.alive === 'degraded').length,
        dead: servers.filter((s) => s.alive === 'dead').length,
        clusterAlive: clusterProbes.filter((s) => s.alive !== 'dead').length,
        invidiousAlive: invProbes.filter((s) => s.alive !== 'dead').length,
        zernioAlive: zernioProbes.filter((s) => s.alive !== 'dead').length,
        pipedAlive: pipedProbes.filter((s) => s.alive !== 'dead').length,
      },
      servers,
    };
  }

  // 独自 API 10: GET /api/kuro/live-servers (全サーバー 生存/遅延/停止 & ストリーム抽出検証)
  app.get('/api/kuro/live-servers', async (req, res) => {
    const refresh = req.query.refresh === 'true';
    const customInv = String(req.query.customInvidious || '').trim();
    const customZernio = String(req.query.customZernio || '').trim();
    const cacheKey = `kuro:live-servers:${customInv}:${customZernio}`;

    if (!refresh) {
      const cached = cacheGet<LiveServersResponse>(cacheKey);
      if (cached.hit && !cached.stale && cached.data) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Upstream-Node', 'kuro-liveness-monitor');
        res.json(cached.data);
        return;
      }
    }

    const snapshot = await buildLiveServersSnapshot(customInv, customZernio);
    cacheSet(cacheKey, snapshot, 35_000, 'kuro-liveness-monitor');
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Upstream-Node', 'kuro-liveness-monitor');
    res.json(snapshot);
  });

  // ブラウザ検証成功ノードをサーバー側の生存ランキングへ即時反映
  app.post('/api/kuro/nodes/report-live', (req, res) => {
    const body = (req.body || {}) as {
      url?: string;
      category?: 'invidious' | 'zernio' | 'piped';
      ok?: boolean;
      streamVerified?: boolean;
      latencyMs?: number;
    };
    const url = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      res.status(400).json({ error: 'Invalid node URL' });
      return;
    }
    const category =
      body.category === 'zernio' || body.category === 'piped' ? body.category : 'invidious';
    recordExternalNodeOutcome(
      url,
      category,
      body.ok !== false,
      Boolean(body.streamVerified),
      Math.max(1, Number(body.latencyMs || 180)),
      body.ok !== false ? 200 : 502,
      { note: 'ブラウザ実再生検証によりスコア昇格' },
    );
    res.json({ ok: true, registrySize: externalNodeRegistry.size });
  });

  // 先読みプリフェッチ API: 関連上位動画のメタデータ＋サムネイルをバックグラウンド先読み
  app.post('/api/kuro/prefetch', async (req, res) => {
    const idsRaw: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = Array.from(
      new Set<string>(idsRaw.map((x) => String(x || '').trim())),
    )
      .filter((id) => /^[a-zA-Z0-9_-]{6,20}$/.test(id))
      .slice(0, 4);

    if (ids.length === 0) {
      res.json({ queued: 0, ids: [] });
      return;
    }

    // Warm video metadata + maxres thumbnail in background without blocking response
    Promise.allSettled(
      ids.map(async (id) => {
        await ensureVideoCached(id, false).catch(() => null);
        const thumbKey = `thumb:${id}:maxresdefault`;
        if (!cacheGet<Buffer>(thumbKey).hit) {
          const r = await proxiedFetch(`https://i.ytimg.com/vi/${encodeURIComponent(id)}/maxresdefault.jpg`, {
            signal: AbortSignal.timeout(2500),
          }).catch(() => null);
          if (r && r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length > 500) cacheSet(thumbKey, buf, 1_800_000, 'prefetch-thumb');
          }
        }
      }),
    ).catch(() => {});

    res.setHeader('X-Cache', 'DYNAMIC');
    res.setHeader('X-Upstream-Node', 'kuro-inst-05');
    res.json({ queued: ids.length, ids });
  });

  // 独自 API 11: POST /api/kuro/external-recover/:id (外部 Invidious + Zernio/Piped 高性能ランキング自動復旧)
  app.post('/api/kuro/external-recover/:id', async (req, res) => {
    const videoId = String(req.params.id || '').trim();
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).json({ error: '不正な動画IDです' });
      return;
    }

    const body = (req.body || {}) as { customInvidiousUrl?: string; customZernioUrl?: string };
    const customInv = String(body.customInvidiousUrl || '').trim().replace(/\/+$/, '');
    const customZernio = String(body.customZernioUrl || '').trim().replace(/\/+$/, '');

    const [pools, snapshot] = await Promise.all([
      discoverDynamicExternalPools(customInv, customZernio),
      buildLiveServersSnapshot(customInv, customZernio),
    ]);

    const rankedInv = getRankedExternalCandidates(
      'invidious',
      [
        ...(customInv ? [customInv] : []),
        ...snapshot.servers.filter((s) => s.category === 'invidious' && s.alive !== 'dead').map((s) => s.url),
        ...pools.invidious.map((p) => p.uri),
      ],
    ).slice(0, 12);

    const rankedRelay = [
      ...(customZernio ? [customZernio] : []),
      ...getRankedExternalCandidates(
        'zernio',
        pools.zernio.filter((z) => z.id === 'zernio-custom' || z.id === 'zernio-api').map((z) => z.url),
      ),
      ...getRankedExternalCandidates(
        'piped',
        [
          ...snapshot.servers.filter((s) => s.category === 'piped' && s.alive !== 'dead').map((s) => s.url),
          ...pools.piped.map((p) => p.url),
        ],
      ),
    ];
    const uniqueRelays = [...new Set(rankedRelay)].slice(0, 12);

    const attempts: ExternalRecoveryAttempt[] = [];
    const raceTasks: Promise<{
      host: string;
      category: 'invidious' | 'zernio' | 'piped';
      adaptiveFormats: AdaptiveFormat[];
      formatStreams: FormatStream[];
      hlsManifestUrl?: string;
    }>[] = [];

    for (const base of rankedInv) {
      raceTasks.push(
        (async () => {
          const t0 = performance.now();
          try {
            const r = await proxiedFetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`, {
              headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
              signal: AbortSignal.timeout(4000),
            });
            const ms = Math.round(performance.now() - t0);
            if (!r.ok) {
              recordExternalNodeOutcome(base, 'invidious', false, false, ms, r.status);
              throw new Error(`HTTP ${r.status}`);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const d = (await r.json()) as any;
            const adaptiveFormats: AdaptiveFormat[] = (d?.adaptiveFormats || [])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .filter((f: any) => f?.url)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((f: any) => ({
                bitrate: String(f.bitrate || '0'),
                url: String(f.url),
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
            const formatStreams: FormatStream[] = (d?.formatStreams || [])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .filter((f: any) => f?.url)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((f: any) => ({
                url: String(f.url),
                proxyUrl: `/api/v1/stream/googlevideo/${encodeURIComponent(videoId)}?itag=${encodeURIComponent(String(f.itag || ''))}`,
                itag: String(f.itag || ''),
                type: String(f.type || ''),
                quality: String(f.quality || ''),
                container: String(f.container || 'mp4'),
                encoding: String(f.encoding || 'h264'),
                qualityLabel: String(f.qualityLabel || ''),
                resolution: String(f.resolution || f.qualityLabel || ''),
              }));
            const hlsUrl = typeof d?.hlsUrl === 'string' && d.hlsUrl ? d.hlsUrl : undefined;
            if (!adaptiveFormats.length && !formatStreams.length && !hlsUrl) {
              recordExternalNodeOutcome(base, 'invidious', true, false, ms, r.status);
              throw new Error('ストリーム空応答');
            }
            recordExternalNodeOutcome(base, 'invidious', true, true, ms, r.status);
            attempts.push({
              serverName: base.replace(/^https?:\/\//, ''),
              url: base,
              category: 'invidious',
              ok: true,
              latencyMs: ms,
              detail: `${adaptiveFormats.length + formatStreams.length} ストリーム取得成功`,
            });
            return {
              host: base,
              category: 'invidious' as const,
              adaptiveFormats,
              formatStreams,
              hlsManifestUrl: hlsUrl,
            };
          } catch (err) {
            const ms = Math.round(performance.now() - t0);
            recordExternalNodeOutcome(base, 'invidious', false, false, ms, null);
            attempts.push({
              serverName: base.replace(/^https?:\/\//, ''),
              url: base,
              category: 'invidious',
              ok: false,
              latencyMs: ms,
              detail: err instanceof Error ? err.message : '失敗',
            });
            throw err;
          }
        })(),
      );
    }

    for (const base of uniqueRelays) {
      const isZernio = base.includes('zernio') || (Boolean(customZernio) && base === customZernio);
      const cat: 'zernio' | 'piped' = isZernio ? 'zernio' : 'piped';
      raceTasks.push(
        (async () => {
          const t0 = performance.now();
          try {
            let r = await proxiedFetch(`${base}/streams/${encodeURIComponent(videoId)}`, {
              headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
              signal: AbortSignal.timeout(4000),
            });
            if (!r.ok && isZernio) {
              r = await proxiedFetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`, {
                headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
                signal: AbortSignal.timeout(4000),
              });
            }
            const ms = Math.round(performance.now() - t0);
            if (!r.ok) {
              recordExternalNodeOutcome(base, cat, false, false, ms, r.status);
              throw new Error(`HTTP ${r.status}`);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const d = (await r.json()) as any;
            const vList = Array.isArray(d?.videoStreams) ? d.videoStreams : [];
            const aList = Array.isArray(d?.audioStreams) ? d.audioStreams : [];
            const hlsUrl = typeof d?.hls === 'string' && d.hls ? d.hls : typeof d?.hlsUrl === 'string' && d.hlsUrl ? d.hlsUrl : undefined;

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
            if (!adaptiveFormats.length && !formatStreams.length && !hlsUrl) {
              recordExternalNodeOutcome(base, cat, true, false, ms, r.status);
              throw new Error('ストリーム未含');
            }
            recordExternalNodeOutcome(base, cat, true, true, ms, r.status);
            attempts.push({
              serverName: base.replace(/^https?:\/\//, ''),
              url: base,
              category: cat,
              ok: true,
              latencyMs: ms,
              detail: `${adaptiveFormats.length + formatStreams.length} ストリーム取得成功`,
            });
            return {
              host: base,
              category: cat,
              adaptiveFormats,
              formatStreams,
              hlsManifestUrl: hlsUrl,
            };
          } catch (err) {
            const ms = Math.round(performance.now() - t0);
            recordExternalNodeOutcome(base, cat, false, false, ms, null);
            attempts.push({
              serverName: base.replace(/^https?:\/\//, ''),
              url: base,
              category: cat,
              ok: false,
              latencyMs: ms,
              detail: err instanceof Error ? err.message : '失敗',
            });
            throw err;
          }
        })(),
      );
    }

    try {
      const winner = await Promise.any(raceTasks);
      for (const fmt of [...winner.adaptiveFormats, ...winner.formatStreams]) {
        if (fmt.url && fmt.itag) {
          cacheSet(`stream:${videoId}:${fmt.itag}`, { url: fmt.url, type: fmt.type }, 1_800_000, `recover:${winner.host}`);
        }
      }
      const hlsProxyUrl = winner.hlsManifestUrl
        ? `/api/v1/stream/hls-proxy?url=${encodeURIComponent(winner.hlsManifestUrl)}`
        : FFMPEG_AVAILABLE
          ? `/api/v1/stream/hls-gen/${encodeURIComponent(videoId)}/index.m3u8`
          : undefined;

      const existing = cacheGet<VideoResponse>(`video:${videoId}`);
      if (existing.hit && existing.data) {
        cacheSet(
          `video:${videoId}`,
          {
            ...existing.data,
            adaptiveFormats: winner.adaptiveFormats.length ? winner.adaptiveFormats : existing.data.adaptiveFormats,
            formatStreams: winner.formatStreams.length ? winner.formatStreams : existing.data.formatStreams,
            hlsManifestUrl: winner.hlsManifestUrl || existing.data.hlsManifestUrl,
            hlsProxyUrl: hlsProxyUrl || existing.data.hlsProxyUrl,
            directStreamAvailable: true,
            streamErrorReason: undefined,
            upstreamSource: `recover-${winner.category}:${winner.host.replace(/^https?:\/\//, '')}`,
          },
          300_000,
          `recover-${winner.category}`,
        );
      }

      const payload: ExternalRecoveryResponse = {
        ok: true,
        videoId,
        recoveredFrom: winner.host.replace(/^https?:\/\//, ''),
        serverCategory: winner.category,
        adaptiveFormats: winner.adaptiveFormats,
        formatStreams: winner.formatStreams,
        hlsManifestUrl: winner.hlsManifestUrl,
        hlsProxyUrl,
        attempts,
        message: `生存中の外部 ${winner.category.toUpperCase()} サーバー (${winner.host.replace(/^https?:\/\//, '')}) から自動復旧しました。`,
      };
      res.setHeader('X-Cache', 'DYNAMIC');
      res.setHeader('X-Upstream-Node', `recover-${winner.category}`);
      res.json(payload);
    } catch {
      const payload: ExternalRecoveryResponse = {
        ok: false,
        videoId,
        recoveredFrom: null,
        serverCategory: null,
        adaptiveFormats: [],
        formatStreams: [],
        attempts,
        message: '外部 Invidious / Zernio / Piped サーバーから直接ストリームを取得できませんでした。Edu再生 (youtubeeducation.com) を使用できます。',
      };
      res.setHeader('X-Cache', 'DYNAMIC');
      res.setHeader('X-Upstream-Node', 'recover-none');
      res.json(payload);
    }
  });

  // -------------------------------------------------------------------------
  // 18. Auto-Translation (Gemini + Google Translate Fallback) & WebVTT Captions
  // -------------------------------------------------------------------------
  let geminiClient: GoogleGenAI | null = null;
  function getGeminiClient(): GoogleGenAI | null {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    if (!geminiClient) {
      geminiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
    }
    return geminiClient;
  }

  function detectSourceLangHint(text: string): string {
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    if (/[\uac00-\ud7af]/.test(text)) return 'ko';
    if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN';
    if (/[\u0400-\u04ff]/.test(text)) return 'ru';
    if (/[\u0600-\u06ff]/.test(text)) return 'ar';
    return 'Autodetect';
  }

  async function translateWithMyMemory(text: string, targetLang: string): Promise<string> {
    const src = detectSourceLangHint(text);
    const dst = targetLang;
    if (src === dst || (src === 'zh-CN' && dst === 'zh-CN')) return text;

    // MyMemory caps q at ~500 chars per call; chunk cleanly by line/sentence when longer
    const chunks: string[] = [];
    let current = '';
    for (const part of text.split(/(\r?\n|[.!?。！？]\s+)/)) {
      if ((current + part).length > 420 && current) {
        chunks.push(current);
        current = part;
      } else {
        current += part;
      }
      if (chunks.length >= 4) break;
    }
    if (current && chunks.length < 4) chunks.push(current.slice(0, 450));

    const translatedParts = await Promise.all(
      chunks.map(async (chunk) => {
        if (!chunk.trim()) return chunk;
        const lp = `${src}|${dst}`;
        const mmUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(lp)}`;
        const r = await fetch(mmUrl, { signal: AbortSignal.timeout(4500) });
        if (!r.ok) return chunk;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const j = (await r.json()) as any;
        const out = typeof j?.responseData?.translatedText === 'string' ? j.responseData.translatedText : '';
        if (!out || out.includes('MYMEMORY WARNING')) return chunk;
        return out;
      }),
    );

    const merged = translatedParts.join('').trim();
    return merged || text;
  }

  async function translateWithGoogleTranslate(text: string, targetLang: string): Promise<string> {
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
      const r = await proxiedFetch(url, {
        headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
        signal: AbortSignal.timeout(3500),
      });
      if (r.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (await r.json()) as any;
        if (Array.isArray(data?.[0])) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const joined = data[0].map((seg: any) => (typeof seg?.[0] === 'string' ? seg[0] : '')).join('');
          if (joined) return joined;
        }
      }
    } catch {
      // fall through to MyMemory
    }
    return translateWithMyMemory(text, targetLang);
  }

  async function translateStringsServer(
    texts: string[],
    targetLang: string,
  ): Promise<{ translations: string[]; engine: TranslateResponse['engine'] }> {
    if (!texts.length) return { translations: [], engine: 'passthrough' };
    const normalizedLang = targetLang || 'ja';

    const results = [...texts];
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const t = String(texts[i] || '');
      if (!t.trim()) continue;
      const hash = crypto.createHash('sha1').update(`${normalizedLang}:${t}`).digest('hex').slice(0, 16);
      const cached = cacheGet<string>(`tr:${hash}`);
      if (cached.hit && cached.data) {
        results[i] = cached.data;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(t);
      }
    }

    if (uncachedTexts.length === 0) {
      return { translations: results, engine: 'passthrough' };
    }

    const ai = getGeminiClient();
    if (ai) {
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Translate every string in this JSON array naturally into language code "${normalizedLang}". Preserve proper nouns, numbers, emojis, and formatting. Return ONLY a JSON array of the same length:\n${JSON.stringify(uncachedTexts)}`,
          config: {
            systemInstruction:
              'You are a fast, accurate media subtitle and metadata translator. Return a JSON array with the exact same number of strings in the exact same order.',
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
        });
        const parsed = JSON.parse((response.text ?? '[]').trim()) as unknown;
        if (Array.isArray(parsed) && parsed.length === uncachedTexts.length) {
          parsed.forEach((tr, idx) => {
            const out = typeof tr === 'string' && tr.trim() ? tr : uncachedTexts[idx];
            results[uncachedIndices[idx]] = out;
            const hash = crypto
              .createHash('sha1')
              .update(`${normalizedLang}:${uncachedTexts[idx]}`)
              .digest('hex')
              .slice(0, 16);
            cacheSet(`tr:${hash}`, out, 3_600_000, 'gemini-4-hydrogen');
          });
          return { translations: results, engine: 'gemini-4-hydrogen' };
        }
      } catch {
        // Fall through to Google Translate endpoint below
      }
    }

    // Fast parallel Google Translate fallback
    await Promise.all(
      uncachedTexts.map(async (orig, idx) => {
        try {
          const translated = await translateWithGoogleTranslate(orig.slice(0, 2800), normalizedLang);
          results[uncachedIndices[idx]] = translated;
          const hash = crypto
            .createHash('sha1')
            .update(`${normalizedLang}:${orig}`)
            .digest('hex')
            .slice(0, 16);
          cacheSet(`tr:${hash}`, translated, 3_600_000, 'google-translate');
        } catch {
          // keep original text on failure
        }
      }),
    );

    return { translations: results, engine: 'google-translate' };
  }

  // 独自 API 12: POST /api/v1/translate (海外動画タイトル・概要・コメント一括自動翻訳)
  app.post('/api/v1/translate', async (req, res) => {
    const body = (req.body || {}) as { texts?: unknown; targetLang?: string };
    const rawTexts = Array.isArray(body.texts) ? body.texts.slice(0, 40).map((t) => String(t ?? '')) : [];
    const targetLang = String(body.targetLang || 'ja').trim() || 'ja';

    if (rawTexts.length === 0) {
      res.json({ translations: [], targetLang, engine: 'passthrough' } satisfies TranslateResponse);
      return;
    }

    const { translations, engine } = await translateStringsServer(rawTexts, targetLang);
    res.setHeader('X-Cache', 'DYNAMIC');
    res.setHeader('X-Upstream-Node', `kuro-translate-${engine}`);
    res.json({ translations, targetLang, engine } satisfies TranslateResponse);
  });

  // 独自 API 13: GET /api/v1/captions/:id?lang=ja (WebVTT 自動翻訳字幕トラック)
  app.get('/api/v1/captions/:id', async (req, res) => {
    const videoId = String(req.params.id || '').trim();
    const targetLang = String(req.query.lang || 'ja').trim() || 'ja';
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) {
      res.status(400).end();
      return;
    }

    const cacheKey = `vtt:${videoId}:${targetLang}`;
    const cached = cacheGet<string>(cacheKey);
    if (cached.hit && cached.data) {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('X-Cache', 'HIT');
      res.send(cached.data);
      return;
    }

    try {
      const yt = await getYt();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info: any = await yt.getInfo(videoId).catch(() => null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tracks: any[] = Array.isArray(info?.captions?.caption_tracks)
        ? info.captions.caption_tracks
        : [];

      const exactTrack = tracks.find(
        (t) => String(t.language_code || '').toLowerCase() === targetLang.toLowerCase(),
      );
      const sourceTrack =
        exactTrack ||
        tracks.find((t) => String(t.language_code || '').startsWith('en')) ||
        tracks[0];

      if (!sourceTrack?.base_url) {
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.send('WEBVTT\n\n');
        return;
      }

      const rawBase = String(sourceTrack.base_url);
      const vttUrl = rawBase.includes('fmt=') ? rawBase.replace(/fmt=[^&]+/, 'fmt=vtt') : `${rawBase}&fmt=vtt`;
      const capRes = await proxiedFetch(vttUrl, {
        headers: { 'User-Agent': PRIVACY_USER_AGENTS[0] },
        signal: AbortSignal.timeout(4500),
      });
      if (!capRes.ok) {
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.send('WEBVTT\n\n');
        return;
      }

      let vttText = await capRes.text();
      if (!vttText.startsWith('WEBVTT')) {
        vttText = `WEBVTT\n\n${vttText}`;
      }

      // Translate cue lines if source caption is in a different language
      if (!exactTrack) {
        const blocks = vttText.split(/\r?\n\r?\n/);
        const cueBlocks: { idx: number; timing: string; text: string }[] = [];
        for (let i = 1; i < blocks.length && cueBlocks.length < 40; i++) {
          const lines = blocks[i].split(/\r?\n/).filter(Boolean);
          const timingIdx = lines.findIndex((l) => l.includes('-->'));
          if (timingIdx >= 0 && lines.length > timingIdx + 1) {
            const cueBody = lines
              .slice(timingIdx + 1)
              .join(' ')
              .replace(/<[^>]+>/g, '')
              .trim();
            if (cueBody) {
              cueBlocks.push({ idx: i, timing: lines[timingIdx], text: cueBody });
            }
          }
        }
        if (cueBlocks.length > 0) {
          const { translations } = await translateStringsServer(
            cueBlocks.map((c) => c.text),
            targetLang,
          );
          const rebuilt = ['WEBVTT', ''];
          cueBlocks.forEach((c, idx) => {
            rebuilt.push(c.timing);
            rebuilt.push(translations[idx] || c.text);
            rebuilt.push('');
          });
          vttText = rebuilt.join('\n');
        }
      }

      cacheSet(cacheKey, vttText, 600_000, 'kuro-vtt');
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('X-Cache', 'MISS');
      res.send(vttText);
    } catch {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.send('WEBVTT\n\n');
    }
  });

  // Start 5 isolated self-hosted Stream Origin Servers on loopback 127.0.0.1:3001 - 3005
  await Promise.all(
    ORIGIN_INSTANCES.map(
      (inst) =>
        new Promise<void>((resolve) => {
          const instApp = express();
          instApp.use(compression({ threshold: 512 }));
          instApp.use(express.json({ limit: '256kb' }));

          // Origin Isolation Guard: Rejects ANY direct access not signed by the Reverse Proxy Shield
          instApp.use((req, res, next) => {
            const token = req.headers['x-kuro-origin-token'];
            if (token !== ORIGIN_AUTH_TOKEN) {
              res.status(403).json({
                error: `オリジンサーバー ${inst.id} (:${inst.port}) への直接アクセスは遮断されました (403 Forbidden)。リバースプロキシ (:3000) 経由でアクセスしてください。`,
                originIsolated: true,
                instanceId: inst.id,
                port: inst.port,
              });
              return;
            }
            const nextCount = (instanceRequestCounts.get(inst.port) || 0) + 1;
            instanceRequestCounts.set(inst.port, nextCount);
            res.setHeader('X-Kuro-Instance-Id', inst.id);
            res.setHeader('X-Kuro-Instance-Port', String(inst.port));
            next();
          });

          instApp.get('/health', (_req, res) => {
            res.json({
              ok: true,
              serverNumber: inst.serverNumber,
              id: inst.id,
              name: inst.name,
              port: inst.port,
              tier: inst.tier,
              handledRequests: instanceRequestCounts.get(inst.port) || 0,
              uptimeSec: Math.round((Date.now() - START_TIME) / 1000),
            });
          });

          instApp.use(originRouter);

          instApp.listen(inst.port, ORIGIN_HOST, () => {
            resolve();
          });
        }),
    ),
  );
  console.log(
    `KuroStream 5 Dedicated Stream Servers isolated on http://${ORIGIN_HOST}:3001-3005`,
  );

  // Background Anubis & Node warm-up so first stream request is instant
  const warmUpTimer = setTimeout(() => {
    solveAnubisForOrigin(`${POKETUBE_BASE}/watch?v=aqz-KE-bpKQ`).catch(() => {});
    buildLiveServersSnapshot().catch(() => {});
  }, 1500);
  warmUpTimer.unref?.();

  const periodicRefreshTimer = setInterval(() => {
    buildLiveServersSnapshot().catch(() => {});
  }, 120_000);
  periodicRefreshTimer.unref?.();

  // -------------------------------------------------------------------------
  // 2. Headless Public API Gateway & Reverse Proxy Shield (0.0.0.0:3000)
  //    (Pure JSON + Media Stream APIs — Zero HTML served)
  // -------------------------------------------------------------------------
  const proxyApp = express();
  proxyApp.use(
    cors({
      origin: '*',
      exposedHeaders: [
        'X-Cache',
        'X-Response-Time',
        'X-Upstream-Node',
        'X-Proxy-Shield',
        'X-Origin-Protected',
        'X-Kuro-Routed-Port',
        'X-Kuro-Instance-Id',
        'X-Kuro-Server-Id',
        'X-Stream-Mode',
        'X-Stream-Quality',
        'Content-Range',
        'Accept-Ranges',
      ],
    }),
  );

  // Global Security Headers on every Proxy response
  proxyApp.use((_req, res, next) => {
    res.setHeader('X-Proxy-Shield', 'active');
    res.setHeader('X-Origin-Protected', 'true');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // 独自 API 3: GET /api/kuro/edge-shield & POST /api/kuro/edge-shield/rules & bypass test
  proxyApp.get('/api/kuro/edge-shield', (_req, res) => {
    const t0 = performance.now();
    const payload: KuroEdgeShieldResponse = {
      status: 'PROTECTED',
      originAddress: `${ORIGIN_HOST}:3001-3005 (5ストリームサーバー隔離)`,
      proxyAddress: `0.0.0.0:${PORT} (ヘッドレスAPIゲートウェイ)`,
      originIsolationActive: true,
      rules: { ...shieldRules },
      counters: { ...shieldCounters },
      recentLogs: shieldAuditLog.slice(0, 30),
    };
    res.setHeader('X-Cache', 'DYNAMIC');
    res.setHeader('X-Upstream-Node', 'kuro-proxy-shield');
    res.setHeader('X-Response-Time', `${Math.max(0.05, performance.now() - t0).toFixed(2)}ms`);
    res.json(payload);
  });

  proxyApp.post('/api/kuro/edge-shield/rules', express.json(), (req, res) => {
    const body = req.body as Partial<ShieldRules>;
    if (typeof body?.rateLimitPerMinute === 'number' && body.rateLimitPerMinute >= 10 && body.rateLimitPerMinute <= 2000) {
      shieldRules.rateLimitPerMinute = Math.round(body.rateLimitPerMinute);
    }
    if (typeof body?.wafStrictMode === 'boolean') {
      shieldRules.wafStrictMode = body.wafStrictMode;
    }
    if (typeof body?.stripClientHeaders === 'boolean') {
      shieldRules.stripClientHeaders = body.stripClientHeaders;
    }
    res.setHeader('X-Cache', 'DYNAMIC');
    res.setHeader('X-Upstream-Node', 'kuro-proxy-shield');
    res.json({ ok: true, rules: { ...shieldRules } });
  });

  // Live Verification Endpoint: Attempts direct connection to 127.0.0.1:3001 WITHOUT proxy token
  proxyApp.post('/api/kuro/edge-shield/test-origin-bypass', async (_req, res) => {
    const t0 = performance.now();
    try {
      const directRes = await fetch(`http://${ORIGIN_HOST}:${ORIGIN_PORT}/api/v1/stats`, {
        signal: AbortSignal.timeout(2000),
      });
      const body = await directRes.json();
      const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
      recordAudit({
        method: 'GET',
        path: '/api/v1/stats (直接接続テスト)',
        clientIpMasked: '127.0.*.*',
        action: 'WAF_BLOCKED',
        statusCode: directRes.status,
        latencyMs,
        reason: 'Proxy署名トークンなしのためオリジンが拒否',
      });
      res.json({
        blocked: directRes.status === 403,
        originStatus: directRes.status,
        latencyMs,
        originResponse: body,
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Test failed' });
    }
  });

  // Reverse Proxy Shield Middleware forwarding /api/* and /latest_version across 5 Origin Stream Servers (3001-3005)
  proxyApp.use(['/api', '/latest_version'], (req, res) => {
    const reqStart = performance.now();
    const rawIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const maskedIp = maskIp(rawIp);

    const isLightweightMedia =
      req.originalUrl.startsWith('/api/v1/thumbnail/') ||
      req.originalUrl.startsWith('/api/v1/media-proxy') ||
      req.originalUrl.includes('/hls/') ||
      req.originalUrl.includes('/hls-gen/');

    // 1. WAF Inspection
    if (shieldRules.wafStrictMode) {
      const threat = detectWafThreat(req);
      if (threat) {
        shieldCounters.totalProxied += 1;
        shieldCounters.wafBlocked += 1;
        const ms = Math.round((performance.now() - reqStart) * 100) / 100;
        recordAudit({
          method: req.method,
          path: req.originalUrl,
          clientIpMasked: maskedIp,
          action: 'WAF_BLOCKED',
          statusCode: 403,
          latencyMs: ms,
          reason: threat,
        });
        res.status(403).json({
          error: `プロキシ WAF により遮断されました: ${threat}`,
          shieldAction: 'WAF_BLOCKED',
        });
        return;
      }
    }

    // 2. Sliding-Window Rate Limiter
    if (!isLightweightMedia) {
      const rate = checkRateLimit(rawIp);
      if (!rate.allowed) {
        shieldCounters.totalProxied += 1;
        shieldCounters.rateLimited += 1;
        const ms = Math.round((performance.now() - reqStart) * 100) / 100;
        recordAudit({
          method: req.method,
          path: req.originalUrl,
          clientIpMasked: maskedIp,
          action: 'RATE_LIMITED',
          statusCode: 429,
          latencyMs: ms,
          reason: `レート制限超過 (${shieldRules.rateLimitPerMinute} req/min)`,
        });
        res.setHeader('Retry-After', String(rate.retryAfterSec));
        res.status(429).json({
          error: 'プロキシ レート制限を超過しました。しばらく待ってから再試行してください。',
          retryAfterSeconds: rate.retryAfterSec,
        });
        return;
      }
    }

    // 3. Header Sanitization + Signed Origin Forwarding across 5 Stream Servers
    const forwardHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const lower = k.toLowerCase();
      if (lower === 'host' || lower === 'connection') continue;
      if (
        shieldRules.stripClientHeaders &&
        (lower === 'x-forwarded-for' ||
          lower === 'x-real-ip' ||
          lower === 'via' ||
          lower === 'cookie' ||
          lower === 'referer')
      ) {
        continue;
      }
      forwardHeaders[k] = v;
    }
    forwardHeaders['x-kuro-origin-token'] = ORIGIN_AUTH_TOKEN;
    const publicProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const publicHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (typeof req.headers.origin === 'string' && req.headers.origin.startsWith('http')) {
      forwardHeaders['x-kuro-public-origin'] = req.headers.origin;
    } else if (publicHost) {
      forwardHeaders['x-kuro-public-origin'] = `${publicProto}://${publicHost}`;
    }

    const candidatePorts = pickOriginPortForPath(req.originalUrl);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

    const forwardToPort = (attemptIdx: number, bufferedBody?: Buffer) => {
      const targetPort = candidatePorts[attemptIdx];
      const proxyReq = http.request(
        {
          hostname: ORIGIN_HOST,
          port: targetPort,
          path: req.originalUrl,
          method: req.method,
          headers: forwardHeaders,
        },
        (proxyRes) => {
          const statusCode = proxyRes.statusCode || 502;
          const xCache = String(proxyRes.headers['x-cache'] || '');

          if (!isLightweightMedia) {
            shieldCounters.totalProxied += 1;
            if (xCache === 'HIT') {
              shieldCounters.cacheHits += 1;
            } else {
              shieldCounters.allowed += 1;
            }
            const ms = Math.round((performance.now() - reqStart) * 100) / 100;
            recordAudit({
              method: req.method,
              path: req.originalUrl,
              clientIpMasked: maskedIp,
              action: xCache === 'HIT' ? 'CACHE_HIT' : 'ALLOW',
              statusCode,
              latencyMs: ms,
            });
          }

          res.status(statusCode);
          for (const [hk, hv] of Object.entries(proxyRes.headers)) {
            if (hv !== undefined && hk.toLowerCase() !== 'transfer-encoding') {
              res.setHeader(hk, hv);
            }
          }
          res.setHeader('X-Kuro-Routed-Port', String(targetPort));
          proxyRes.pipe(res);
        },
      );

      proxyReq.on('error', (err) => {
        if (!res.headersSent && !hasBody && attemptIdx + 1 < Math.min(3, candidatePorts.length)) {
          forwardToPort(attemptIdx + 1, bufferedBody);
          return;
        }
        if (!res.headersSent) {
          res.status(502).json({ error: `プロキシ転送エラー: ${err.message}` });
        }
      });

      res.on('close', () => {
        if (!res.writableEnded && !proxyReq.destroyed) proxyReq.destroy();
      });

      if (hasBody) {
        req.pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    };

    forwardToPort(0);
  });

  // Pure Headless Server Mode (Zero HTML / Zero Vite SPA)
  proxyApp.get(['/', '/health'], (_req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({
      ok: true,
      service: 'KuroStream Headless 5-Server Stream Cluster',
      mode: 'headless-server-only',
      htmlDisabled: true,
      uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
      gatewayPort: PORT,
      streamServers: ORIGIN_INSTANCES.map((s) => ({
        serverNumber: s.serverNumber,
        id: s.id,
        name: s.name,
        port: s.port,
        tier: s.tier,
        tierLabel: s.tierLabel,
        protocol: s.protocol,
        capabilities: s.capabilities,
        handledRequests: instanceRequestCounts.get(s.port) || 0,
        endpoints: {
          health: `/api/server/${s.serverNumber}/health`,
          info: `/api/server/${s.serverNumber}/info/:id`,
          stream: `/api/server/${s.serverNumber}/stream/:id`,
        },
      })),
      endpoints: {
        videoInfo: '/api/v1/videos/:id',
        search: '/api/v1/search?q=...',
        googlevideoRangeMp4: '/api/v1/stream/googlevideo/:id?itag=18',
        ffmpegMux1080p4kMp4: '/api/v1/stream/mux?id=:id',
        adaptiveHlsM3u8: '/api/v1/stream/hls-gen/:id/index.m3u8',
        autoFallback: '/api/kuro/auto-fallback/:id',
        clusterNodes: '/api/kuro/cluster-nodes',
        liveServers: '/api/kuro/live-servers',
        edgeShield: '/api/kuro/edge-shield',
        eduEmbed: '/api/kuro/edu-embed/:id',
      },
    });
  });

  proxyApp.use((req, res) => {
    res.status(404).json({
      error: 'Endpoint not found (headless stream server mode — HTML disabled)',
      path: req.originalUrl,
      index: '/',
    });
  });

  proxyApp.listen(PORT, '0.0.0.0', () => {
    console.log(
      `KuroStream Headless API Gateway listening on http://0.0.0.0:${PORT} -> 5 Stream Servers ${ORIGIN_HOST}:3001-3005`,
    );
  });
}

startServer().catch((err) => {
  console.error('Failed to start KuroStream server:', err);
  process.exit(1);
});
