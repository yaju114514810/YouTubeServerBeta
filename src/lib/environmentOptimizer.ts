import type { AdaptiveFormat, FormatStream, OptimizationMode, VideoResponse } from '../types/invidious';

export interface DeviceEnvironmentProfile {
  effectiveType: string;
  downlinkMbps: number;
  saveData: boolean;
  maxScreenHeight: number;
  supportsAv1: boolean;
  supportsVp9: boolean;
  supportsH264: boolean;
  recommendedMaxHeight: number;
  summaryText: string;
}

export function detectDeviceEnvironment(): DeviceEnvironmentProfile {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nav = typeof navigator !== 'undefined' ? (navigator as any) : null;
  const conn = nav?.connection || nav?.mozConnection || nav?.webkitConnection;

  const effectiveType = String(conn?.effectiveType || '4g');
  const rawDownlink = Number(conn?.downlink);
  const downlinkMbps = Number.isFinite(rawDownlink) && rawDownlink > 0 ? rawDownlink : 25;
  const saveData = Boolean(conn?.saveData);

  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
  const screenH =
    typeof window !== 'undefined'
      ? Math.max(window.innerHeight || 720, (window.screen?.height || 1080) * (dpr >= 1.5 ? 1.5 : 1))
      : 1080;
  const maxScreenHeight = Math.round(screenH);

  const probeCodec = (mime: string): boolean => {
    if (typeof document === 'undefined') return true;
    try {
      const v = document.createElement('video');
      return v.canPlayType(mime) !== '';
    } catch {
      return false;
    }
  };

  const supportsH264 = probeCodec('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
  const supportsVp9 = probeCodec('video/webm; codecs="vp9"');
  const supportsAv1 = probeCodec('video/mp4; codecs="av01.0.08M.08"');

  let recommendedMaxHeight = 2160;
  if (saveData || effectiveType === 'slow-2g' || effectiveType === '2g' || downlinkMbps < 2) {
    recommendedMaxHeight = 360;
  } else if (effectiveType === '3g' || downlinkMbps < 5) {
    recommendedMaxHeight = 720;
  } else if (downlinkMbps < 15 || maxScreenHeight <= 1080) {
    recommendedMaxHeight = 1080;
  } else if (downlinkMbps < 25 || maxScreenHeight <= 1440) {
    recommendedMaxHeight = 1440;
  }

  const netLabel = saveData
    ? '節約モード'
    : `${effectiveType.toUpperCase()} (${downlinkMbps.toFixed(0)}Mbps)`;
  const codecLabel = supportsVp9 || supportsAv1 ? 'H.264/VP9' : 'H.264安全';
  const summaryText = `環境最適化: ${netLabel} · ${codecLabel} · 最大 ${recommendedMaxHeight}p 目安`;

  return {
    effectiveType,
    downlinkMbps,
    saveData,
    maxScreenHeight,
    supportsAv1,
    supportsVp9,
    supportsH264,
    recommendedMaxHeight,
    summaryText,
  };
}

export function pickOptimalVideoTrack(
  videoTracks: AdaptiveFormat[],
  env: DeviceEnvironmentProfile,
  mode: OptimizationMode,
  manualMaxHeight?: number | 'auto',
): AdaptiveFormat | null {
  if (videoTracks.length === 0) return null;

  const capHeight =
    typeof manualMaxHeight === 'number' && manualMaxHeight > 0
      ? manualMaxHeight
      : mode === 'hq'
        ? 4320
        : mode === 'stable'
          ? 720
          : mode === 'fast'
            ? Math.min(1080, env.recommendedMaxHeight)
            : env.recommendedMaxHeight;

  const isPlayable = (f: AdaptiveFormat): boolean => {
    const enc = f.encoding.toLowerCase();
    if (typeof manualMaxHeight === 'number' && manualMaxHeight >= 1440) {
      if (enc.includes('av01') || enc.includes('av1')) return env.supportsAv1;
      if (enc.includes('vp9') || enc.includes('vp09')) return env.supportsVp9;
      return true;
    }
    if (enc.includes('av01') || enc.includes('av1')) return env.supportsAv1 && mode !== 'stable';
    if (enc.includes('vp9') || enc.includes('vp09')) return env.supportsVp9 && mode !== 'stable';
    return true;
  };

  const compatible = videoTracks.filter(isPlayable);
  const pool = compatible.length > 0 ? compatible : videoTracks;

  const scored = pool.map((f) => {
    const h = parseInt(f.qualityLabel || f.resolution || '0', 10) || 0;
    const isH264 = f.encoding.toLowerCase().includes('avc1') || f.container === 'mp4';
    const underCap = h <= capHeight;
    let score = underCap ? h : capHeight - (h - capHeight) * 0.5;
    if ((mode === 'stable' || mode === 'fast') && (!manualMaxHeight || manualMaxHeight === 'auto') && isH264) {
      score += 250;
    }
    if ((mode === 'hq' || (typeof manualMaxHeight === 'number' && manualMaxHeight >= 1080)) && (f.fps || 30) >= 50) {
      score += 120;
    }
    if (typeof manualMaxHeight === 'number' && h === manualMaxHeight) {
      score += 400;
    }
    return { f, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.f || videoTracks[0];
}

export function pickOptimalProgressiveTrack(
  formatStreams: FormatStream[],
  env: DeviceEnvironmentProfile,
  mode: OptimizationMode,
  manualMaxHeight?: number | 'auto',
): FormatStream | null {
  if (formatStreams.length === 0) return null;
  const capHeight =
    typeof manualMaxHeight === 'number' && manualMaxHeight > 0
      ? manualMaxHeight
      : mode === 'hq'
        ? 1080
        : mode === 'stable'
          ? 720
          : env.recommendedMaxHeight;

  const sorted = [...formatStreams].sort((a, b) => {
    const hA = parseInt(a.qualityLabel || a.resolution || '0', 10) || 0;
    const hB = parseInt(b.qualityLabel || b.resolution || '0', 10) || 0;
    const fitA = hA <= capHeight ? hA : capHeight - (hA - capHeight);
    const fitB = hB <= capHeight ? hB : capHeight - (hB - capHeight);
    return fitB - fitA;
  });
  return sorted[0] || formatStreams[0];
}

export function chooseBestEngineForProfile(
  data: VideoResponse,
  mode: OptimizationMode,
  fromBrowser: boolean,
  ffmpegAvailable: boolean,
  manualMaxHeight?: number | 'auto',
): 'googlevideo' | 'mux' | 'hls' | 'progressive' | 'sync' | 'relay' | 'edu-classroom' {
  if (mode === 'edu') return 'edu-classroom';

  const hasAdaptive =
    data.adaptiveFormats.some((f) => f.type.startsWith('video/')) &&
    data.adaptiveFormats.some((f) => f.type.startsWith('audio/'));
  const hasProg = data.formatStreams.length > 0;

  // When user manually picks 1080p+ and adaptive formats exist, prefer adaptive/HLS/mux over 720p progressive
  if (typeof manualMaxHeight === 'number' && manualMaxHeight >= 1080) {
    if (data.hlsProxyUrl) return 'hls';
    if (ffmpegAvailable && hasAdaptive) return 'mux';
    if (hasAdaptive) return 'sync';
    if (hasProg) return 'googlevideo';
    return 'edu-classroom';
  }

  if (mode === 'stable') {
    if (hasProg) return 'googlevideo';
    if (data.hlsProxyUrl) return 'hls';
    if (ffmpegAvailable && hasAdaptive) return 'mux';
    if (hasAdaptive) return 'sync';
    if (data.clientRelayStreams?.length) return 'relay';
    return 'edu-classroom';
  }

  if (mode === 'fast') {
    if (hasProg) return 'googlevideo';
    if (data.hlsProxyUrl) return 'hls';
    if (ffmpegAvailable && hasAdaptive) return 'mux';
    if (hasAdaptive) return 'sync';
    return 'edu-classroom';
  }

  if (mode === 'hq') {
    if (ffmpegAvailable && hasAdaptive) return 'mux';
    if (data.hlsProxyUrl) return 'hls';
    if (hasAdaptive) return 'sync';
    if (hasProg) return 'googlevideo';
    return 'edu-classroom';
  }

  // Auto environment-optimized order: Googlevideo (native HTTP 206 seekable) or HLS -> Mux -> Sync -> Edu
  if (hasProg) return 'googlevideo';
  if (!fromBrowser && ffmpegAvailable && hasAdaptive) return 'mux';
  if (data.hlsProxyUrl) return 'hls';
  if (hasAdaptive) return 'sync';
  if (data.clientRelayStreams?.length) return 'relay';
  return 'edu-classroom';
}
