import { useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import {
  Activity,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  Copy,
  Download,
  ExternalLink,
  FastForward,
  GraduationCap,
  KeyRound,
  Languages,
  RefreshCw,
  Rewind,
  Settings2,
  SkipForward,
} from 'lucide-react';
import type {
  AdaptiveFormat,
  CommentsResponse,
  EduEmbedConfig,
  LiveServersResponse,
  OptimizationMode,
  RecommendedVideo,
  SearchVideoItem,
  StreamConfigStatus,
  VideoResponse,
  YouTubeAuthStatus,
} from '../types/invidious';
import {
  extractVideoId,
  fetchVideoCached,
  formatCompactNumber,
  formatDuration,
  prefetchVideo,
  preloadNextVideos,
  probeApi,
  updateClientVideoCache,
} from '../lib/api';
import { useAppSettings } from '../lib/appSettings';
import {
  chooseBestEngineForProfile,
  detectDeviceEnvironment,
  pickOptimalProgressiveTrack,
  pickOptimalVideoTrack,
} from '../lib/environmentOptimizer';
import {
  recoverPlaybackFromExternalNodes,
  triggerDirectDownload,
} from '../lib/streamResolver';
import { translateTexts } from '../lib/translator';
import { rankRelatedVideos, recordWatch } from '../lib/watchHistory';

interface PlayerViewProps {
  videoId: string;
  onSelectVideo: (videoId: string) => void;
  onSelectChannel: (channelId: string) => void;
  onInspectInApi: (endpoint: string) => void;
  onBackToExplorer: () => void;
}

type StreamEngineMode =
  | 'googlevideo'
  | 'mux'
  | 'hls'
  | 'progressive'
  | 'sync'
  | 'relay'
  | 'edu-classroom'
  | 'edu-kahoot'
  | 'edu-workspace';

const OPTIMIZATION_PROFILES: { id: OptimizationMode; label: string }[] = [
  { id: 'auto', label: '自動最適化 (環境判定)' },
  { id: 'fast', label: '高速型 (Googlevideo)' },
  { id: 'hq', label: '高画質型 (4K MP4/HLS)' },
  { id: 'stable', label: '安定型 (学校端末向け)' },
  { id: 'edu', label: 'Edu再生 (Classroom/Kahoot)' },
];

const MANUAL_QUALITY_OPTIONS: { value: 'auto' | number; label: string }[] = [
  { value: 'auto', label: '画質: 自動 (環境最適化)' },
  { value: 2160, label: '画質: 4K UHD (2160p)' },
  { value: 1440, label: '画質: QHD (1440p)' },
  { value: 1080, label: '画質: フルHD (1080p)' },
  { value: 720, label: '画質: HD (720p)' },
  { value: 480, label: '画質: SD (480p)' },
  { value: 360, label: '画質: 軽量 (360p)' },
];

export function PlayerView({
  videoId,
  onSelectVideo,
  onSelectChannel,
  onInspectInApi,
  onBackToExplorer,
}: PlayerViewProps) {
  const [inputId, setInputId] = useState(videoId);
  const [video, setVideo] = useState<VideoResponse | null>(null);
  const [eduConfig, setEduConfig] = useState<EduEmbedConfig | null>(null);
  const [comments, setComments] = useState<CommentsResponse | null>(null);
  const [fallbackRelated, setFallbackRelated] = useState<RecommendedVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolvingBrowser, setResolvingBrowser] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [autoFallbackNote, setAutoFallbackNote] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    latencyMs: number;
    cacheStatus: string;
    upstreamNode: string;
  } | null>(null);
  const [showDesc, setShowDesc] = useState(false);

  const [settings, updateSettings] = useAppSettings();
  const envProfile = useMemo(() => detectDeviceEnvironment(), []);
  const [optMode, setOptMode] = useState<OptimizationMode>('auto');
  const [manualQuality, setManualQuality] = useState<'auto' | number>('auto');
  const [engineMode, setEngineMode] = useState<StreamEngineMode>('googlevideo');
  const [selectedVideoItag, setSelectedVideoItag] = useState<string>('');
  const [selectedAudioItag, setSelectedAudioItag] = useState<string>('');
  const [selectedRelayUrl, setSelectedRelayUrl] = useState<string>('');
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [autoPlayNext, setAutoPlayNext] = useState<boolean>(true);
  const [browserResolvedMode, setBrowserResolvedMode] = useState(false);
  const [muxSeekOffsetSec, setMuxSeekOffsetSec] = useState(0);
  const [hlsFallbackToGen, setHlsFallbackToGen] = useState(false);
  const [showDownloadMenu, setShowDownloadMenu] = useState(false);
  const [copiedEduUrl, setCopiedEduUrl] = useState(false);
  const [skipFeedback, setSkipFeedback] = useState<string | null>(null);

  // 自動翻訳表示状態
  const [showOriginalText, setShowOriginalText] = useState(false);
  const [translatedTitle, setTranslatedTitle] = useState<string | null>(null);
  const [translatedDesc, setTranslatedDesc] = useState<string | null>(null);
  const [translatedComments, setTranslatedComments] = useState<Record<string, string>>({});
  const [translatedRecTitles, setTranslatedRecTitles] = useState<Record<string, string>>({});

  // 死活監視 & 外部自動復旧状態
  const [liveSummary, setLiveSummary] = useState<LiveServersResponse['summary'] | null>(null);
  const [checkingLive, setCheckingLive] = useState(false);
  const [recoveringExternal, setRecoveringExternal] = useState(false);

  // 接続設定ドロワー
  const [showConfig, setShowConfig] = useState(false);
  const [streamCfg, setStreamCfg] = useState<StreamConfigStatus | null>(null);
  const [cookieInput, setCookieInput] = useState('');
  const [upstreamInput, setUpstreamInput] = useState('');
  const [proxyInput, setProxyInput] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);

  // YouTube TV デバイス認証
  const [authState, setAuthState] = useState<YouTubeAuthStatus>({ status: 'idle' });
  const [startingAuth, setStartingAuth] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const triedModesRef = useRef<Set<StreamEngineMode>>(new Set());
  const silentRefreshedRef = useRef(false);
  const externalRecoveryTriedRef = useRef(false);
  const resumeTimeRef = useRef<number>(0);
  const stallTimerRef = useRef<number | null>(null);
  const skipBadgeTimerRef = useRef<number | null>(null);

  const checkLiveServers = async (refresh = false) => {
    setCheckingLive(true);
    try {
      const qs = new URLSearchParams();
      if (refresh) qs.set('refresh', 'true');
      if (settings.customInvidiousUrl) qs.set('customInvidious', settings.customInvidiousUrl);
      if (settings.customZernioUrl) qs.set('customZernio', settings.customZernioUrl);
      const res = await probeApi<LiveServersResponse>(`/api/kuro/live-servers?${qs.toString()}`);
      setLiveSummary(res.data.summary);
    } catch {
      // non-fatal
    } finally {
      setCheckingLive(false);
    }
  };

  const loadConfig = async () => {
    try {
      const [cfgRes, authRes] = await Promise.all([
        probeApi<StreamConfigStatus>('/api/v1/config/stream'),
        probeApi<YouTubeAuthStatus>('/api/v1/auth/youtube/status'),
      ]);
      setStreamCfg(cfgRes.data);
      setUpstreamInput(cfgRes.data.customUpstreamUrl || '');
      setProxyInput(cfgRes.data.outboundProxyUrl || '');
      setAuthState(authRes.data);
      return cfgRes.data;
    } catch {
      return null;
    }
  };

  const videoTracks = useMemo<AdaptiveFormat[]>(() => {
    if (!video) return [];
    return video.adaptiveFormats
      .filter((f) => f.type.startsWith('video/'))
      .sort((a, b) => {
        const resA = parseInt(a.qualityLabel || '0', 10) || 0;
        const resB = parseInt(b.qualityLabel || '0', 10) || 0;
        if (resB !== resA) return resB - resA;
        return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
      });
  }, [video]);

  const audioTracks = useMemo<AdaptiveFormat[]>(() => {
    if (!video) return [];
    return video.adaptiveFormats
      .filter((f) => f.type.startsWith('audio/'))
      .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));
  }, [video]);

  const rankedRecommendations = useMemo(() => {
    const raw =
      video?.recommendedVideos && video.recommendedVideos.length > 0
        ? video.recommendedVideos
        : fallbackRelated;
    if (!raw || raw.length === 0) return [];
    return rankRelatedVideos(raw, video?.videoId || videoId);
  }, [video, fallbackRelated, videoId]);

  const applyResolvedTracks = (
    data: VideoResponse,
    fromBrowser = false,
    cfg?: StreamConfigStatus | null,
    targetProfile: OptimizationMode = optMode,
    targetQuality: 'auto' | number = manualQuality,
  ) => {
    setBrowserResolvedMode(fromBrowser);
    triedModesRef.current = new Set();

    const vTracks = data.adaptiveFormats
      .filter((f) => f.type.startsWith('video/'))
      .sort((a, b) => {
        const rA = parseInt(a.qualityLabel || '0', 10) || 0;
        const rB = parseInt(b.qualityLabel || '0', 10) || 0;
        if (rB !== rA) return rB - rA;
        return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
      });
    const aTracks = data.adaptiveFormats
      .filter((f) => f.type.startsWith('audio/'))
      .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0));

    const optVideo = pickOptimalVideoTrack(vTracks, envProfile, targetProfile, targetQuality);
    const optProg = pickOptimalProgressiveTrack(data.formatStreams, envProfile, targetProfile, targetQuality);
    const ffmpegReady = cfg ? cfg.ffmpegAvailable : (streamCfg?.ffmpegAvailable ?? true);

    const chosen = chooseBestEngineForProfile(
      data,
      targetProfile,
      fromBrowser,
      ffmpegReady,
      targetQuality,
    );

    if (chosen === 'googlevideo' || chosen === 'progressive') {
      if (optProg) setSelectedVideoItag(optProg.itag);
      else if (optVideo) setSelectedVideoItag(optVideo.itag);
    } else if (optVideo) {
      setSelectedVideoItag(optVideo.itag);
    } else if (optProg) {
      setSelectedVideoItag(optProg.itag);
    }

    if (aTracks[0]) setSelectedAudioItag(aTracks[0].itag);
    if (data.clientRelayStreams?.[0]) setSelectedRelayUrl(data.clientRelayStreams[0].url);

    triedModesRef.current.add(chosen);
    setEngineMode(chosen);
  };

  const loadVideo = async (id: string, refresh = false, preserveSilentFlag = false) => {
    setLoading(true);
    setError(null);
    setStreamError(null);
    setAutoFallbackNote(null);
    setShowDownloadMenu(false);
    setBrowserResolvedMode(false);
    setMuxSeekOffsetSec(0);
    setHlsFallbackToGen(false);
    setFallbackRelated([]);
    setTranslatedTitle(null);
    setTranslatedDesc(null);
    setTranslatedComments({});
    setTranslatedRecTitles({});
    resumeTimeRef.current = 0;
    setInputId(id);
    if (!preserveSilentFlag) {
      silentRefreshedRef.current = false;
      externalRecoveryTriedRef.current = false;
    }

    try {
      const [vidRes, commRes, eduRes, latestCfg] = await Promise.allSettled([
        fetchVideoCached(id, refresh),
        probeApi<CommentsResponse>(`/api/v1/comments/${encodeURIComponent(id)}`),
        probeApi<EduEmbedConfig>(`/api/kuro/edu-embed/${encodeURIComponent(id)}`),
        streamCfg ? Promise.resolve(streamCfg) : loadConfig(),
      ]);

      if (vidRes.status === 'rejected') {
        throw vidRes.reason;
      }

      const resolvedCfg = latestCfg.status === 'fulfilled' ? latestCfg.value : streamCfg;
      let data = vidRes.value.data;

      if (eduRes.status === 'fulfilled') {
        setEduConfig(eduRes.value.data);
      } else if (data.eduEmbed) {
        setEduConfig(data.eduEmbed);
      } else {
        const baseEdu = `https://www.youtubeeducation.com/embed/${encodeURIComponent(id)}`;
        setEduConfig({
          videoId: id,
          title: data.title,
          author: data.author,
          classroomUrl: `${baseEdu}?rel=0&playsinline=1&iv_load_policy=3&modestbranding=1&hl=${encodeURIComponent(settings.targetLang)}`,
          kahootUrl: `${baseEdu}?autoplay=1&controls=1&rel=0&playsinline=1&iv_load_policy=3&fs=1&hl=${encodeURIComponent(settings.targetLang)}`,
          nocookieUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&controls=1&rel=0&playsinline=1&iv_load_policy=3&fs=1&hl=${encodeURIComponent(settings.targetLang)}`,
          educationUrl: `${baseEdu}?rel=0&playsinline=1&iv_load_policy=3&hl=${encodeURIComponent(settings.targetLang)}`,
          embeddable: true,
          providerNote: '正規 YouTube Education (youtubeeducation.com) 埋め込み再生',
        });
      }

      setVideo(data);
      setMeta({
        latencyMs: vidRes.value.latencyMs,
        cacheStatus: vidRes.value.cacheStatus,
        upstreamNode: vidRes.value.upstreamNode,
      });
      applyResolvedTracks(data, false, resolvedCfg, optMode, manualQuality);

      if (commRes.status === 'fulfilled') {
        setComments(commRes.value.data);
      } else {
        setComments(null);
      }

      // Guarantee related videos client-side if API returned empty
      if (!data.recommendedVideos || data.recommendedVideos.length === 0) {
        probeApi<SearchVideoItem[]>('/api/v1/trending?type=4K&region=JP')
          .then((tr) => {
            const mapped: RecommendedVideo[] = (tr.data || [])
              .filter((x) => x.videoId !== id)
              .slice(0, 16)
              .map((x) => ({
                videoId: x.videoId,
                title: x.title,
                videoThumbnails: x.videoThumbnails,
                author: x.author,
                authorId: x.authorId,
                lengthSeconds: x.lengthSeconds,
                viewCountText: x.viewCountText,
                viewCount: x.viewCount,
              }));
            if (mapped.length > 0) setFallbackRelated(mapped);
          })
          .catch(() => {});
      }

      recordWatch({
        videoId: data.videoId || id,
        title: data.title,
        author: data.author,
        authorId: data.authorId,
        keywords: data.keywords,
        description: data.description,
      });

      // If primary servers could not extract direct streams, search live external Invidious + Zernio/Piped servers
      if (!data.directStreamAvailable && optMode !== 'edu') {
        setResolvingBrowser(true);
        const { resolved: recovered } = await recoverPlaybackFromExternalNodes(
          id,
          settings.customInvidiousUrl || resolvedCfg?.customUpstreamUrl || undefined,
          settings.customZernioUrl || undefined,
        );
        setResolvingBrowser(false);
        if (
          recovered &&
          (recovered.adaptiveFormats.length > 0 ||
            recovered.formatStreams.length > 0 ||
            recovered.hlsManifestUrl)
        ) {
          externalRecoveryTriedRef.current = true;
          data = {
            ...data,
            adaptiveFormats: recovered.adaptiveFormats,
            formatStreams: recovered.formatStreams,
            hlsManifestUrl: recovered.hlsManifestUrl || data.hlsManifestUrl,
            hlsProxyUrl: recovered.hlsProxyUrl || data.hlsProxyUrl,
            directStreamAvailable: true,
            streamErrorReason: undefined,
            upstreamSource: recovered.sourceHost,
          };
          setVideo(data);
          updateClientVideoCache(id, data, recovered.sourceHost);
          setMeta((prev) =>
            prev ? { ...prev, upstreamNode: recovered.sourceHost } : prev,
          );
          setAutoFallbackNote(
            `外部サーバー自動復旧 (${recovered.category?.toUpperCase() || 'EXTERNAL'}): 生存中の ${recovered.sourceHost} からストリームを取得しました`,
          );
          applyResolvedTracks(data, true, resolvedCfg, optMode, manualQuality);
        } else {
          // Automatic fallback to genuine YouTube Education mode
          setAutoFallbackNote(
            '生ストリームが制限されている環境のため、正規 Edu再生 (youtubeeducation.com) へ自動フォールバックしました',
          );
          setEngineMode('edu-classroom');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '動画データの取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConfig();
    checkLiveServers(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadVideo(videoId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // Auto-translate video title, description, comments, and related titles when enabled
  useEffect(() => {
    if (!settings.autoTranslateEnabled || !video) {
      setTranslatedTitle(null);
      setTranslatedDesc(null);
      setTranslatedRecTitles({});
      return;
    }
    let cancelled = false;

    const batch: string[] = [];
    const titleIdx = settings.translateTitles && video.title ? batch.push(video.title) - 1 : -1;
    const descIdx =
      settings.translateDescriptions && video.description
        ? batch.push(video.description.slice(0, 1800)) - 1
        : -1;

    if (batch.length > 0) {
      translateTexts(batch, settings.targetLang).then((out) => {
        if (cancelled) return;
        setTranslatedTitle(titleIdx >= 0 && out[titleIdx] !== video.title ? out[titleIdx] : null);
        setTranslatedDesc(
          descIdx >= 0 && out[descIdx] !== video.description.slice(0, 1800) ? out[descIdx] : null,
        );
      });
    } else {
      setTranslatedTitle(null);
      setTranslatedDesc(null);
    }

    if (settings.translateTitles && rankedRecommendations.length > 0) {
      const topRecs = rankedRecommendations.slice(0, 16);
      translateTexts(
        topRecs.map((r) => r.title),
        settings.targetLang,
      ).then((out) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        topRecs.forEach((r, idx) => {
          if (out[idx] && out[idx] !== r.title) map[r.videoId] = out[idx];
        });
        setTranslatedRecTitles(map);
      });
    } else {
      setTranslatedRecTitles({});
    }

    return () => {
      cancelled = true;
    };
  }, [
    video,
    rankedRecommendations,
    settings.autoTranslateEnabled,
    settings.translateTitles,
    settings.translateDescriptions,
    settings.targetLang,
  ]);

  useEffect(() => {
    if (!settings.autoTranslateEnabled || !settings.translateComments || !comments?.comments?.length) {
      setTranslatedComments({});
      return;
    }
    let cancelled = false;
    const slice = comments.comments.slice(0, 15);
    translateTexts(
      slice.map((c) => c.content),
      settings.targetLang,
    ).then((out) => {
      if (cancelled) return;
      const map: Record<string, string> = {};
      slice.forEach((c, idx) => {
        if (out[idx] && out[idx] !== c.content) map[c.commentId] = out[idx];
      });
      setTranslatedComments(map);
    });
    return () => {
      cancelled = true;
    };
  }, [comments, settings.autoTranslateEnabled, settings.translateComments, settings.targetLang]);

  // Preload top 3 upcoming related videos + thumbnails automatically for zero-wait next playback
  useEffect(() => {
    if (!loading && rankedRecommendations.length > 0) {
      preloadNextVideos(rankedRecommendations.slice(0, 3).map((r) => r.videoId));
    }
  }, [loading, rankedRecommendations]);

  useEffect(() => {
    if (authState.status !== 'pending') return;
    const timer = window.setInterval(async () => {
      try {
        const res = await probeApi<YouTubeAuthStatus>('/api/v1/auth/youtube/status');
        setAuthState(res.data);
        if (res.data.status === 'authorized') {
          window.clearInterval(timer);
          await loadConfig();
          await loadVideo(videoId, true);
        }
      } catch {
        // ignore transient poll errors
      }
    }, 2500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState.status, videoId]);

  const handleProfileChange = (nextMode: OptimizationMode) => {
    if (videoRef.current && videoRef.current.currentTime > 0) {
      resumeTimeRef.current = videoRef.current.currentTime + (engineMode === 'mux' ? muxSeekOffsetSec : 0);
    }
    setOptMode(nextMode);
    if (video) {
      applyResolvedTracks(video, browserResolvedMode, streamCfg, nextMode, manualQuality);
    } else if (nextMode === 'edu') {
      setEngineMode('edu-classroom');
    }
  };

  const handleManualQualityChange = (rawVal: string) => {
    const nextQ: 'auto' | number = rawVal === 'auto' ? 'auto' : Number(rawVal);
    if (videoRef.current && videoRef.current.currentTime > 0) {
      resumeTimeRef.current = videoRef.current.currentTime + (engineMode === 'mux' ? muxSeekOffsetSec : 0);
    }
    setManualQuality(nextQ);

    if (!video) return;

    // In active HLS mode, switch hls.js level immediately without reloading
    if (engineMode === 'hls' && hlsRef.current && hlsRef.current.levels.length > 0) {
      if (nextQ === 'auto') {
        hlsRef.current.currentLevel = -1;
      } else {
        let bestIdx = 0;
        let bestDiff = Infinity;
        hlsRef.current.levels.forEach((lvl, idx) => {
          const diff = Math.abs((lvl.height || 0) - nextQ);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = idx;
          }
        });
        hlsRef.current.currentLevel = bestIdx;
      }
      return;
    }

    const optV = pickOptimalVideoTrack(videoTracks, envProfile, optMode, nextQ);
    const optP = pickOptimalProgressiveTrack(video.formatStreams, envProfile, optMode, nextQ);

    // Upgrade from 720p Googlevideo/progressive to 4K/1080p adaptive engine when user picks >=1080p
    if (
      typeof nextQ === 'number' &&
      nextQ >= 1080 &&
      (engineMode === 'googlevideo' || engineMode === 'progressive') &&
      videoTracks.length > 0 &&
      audioTracks.length > 0
    ) {
      if (optV) setSelectedVideoItag(optV.itag);
      setSelectedAudioItag(audioTracks[0].itag);
      setMuxSeekOffsetSec(Math.floor(resumeTimeRef.current));
      setEngineMode(streamCfg?.ffmpegAvailable !== false ? 'mux' : 'sync');
      return;
    }

    if (engineMode === 'googlevideo' || engineMode === 'progressive') {
      if (optP) setSelectedVideoItag(optP.itag);
    } else if (optV) {
      setSelectedVideoItag(optV.itag);
    }
  };

  const activeVideoSrc = useMemo(() => {
    if (!video) return '';
    if (engineMode === 'googlevideo') {
      const targetProg =
        video.formatStreams.find((f) => f.itag === selectedVideoItag) || video.formatStreams[0];
      if (targetProg || video.adaptiveFormats.length > 0) {
        const chosenItag = targetProg?.itag || selectedVideoItag || '18';
        const srcParam = targetProg?.url ? `&src=${encodeURIComponent(targetProg.url)}` : '';
        return `/api/v1/stream/googlevideo/${encodeURIComponent(video.videoId)}?itag=${encodeURIComponent(chosenItag)}&profile=${optMode === 'stable' ? 'stable' : 'fast'}${srcParam}`;
      }
      return '';
    }
    if (engineMode === 'mux' && selectedVideoItag && selectedAudioItag) {
      const tParam = muxSeekOffsetSec > 0 ? `&t=${muxSeekOffsetSec}` : '';
      return `/api/v1/stream/mux?id=${encodeURIComponent(video.videoId)}&v=${encodeURIComponent(selectedVideoItag)}&a=${encodeURIComponent(selectedAudioItag)}${tParam}`;
    }
    if (engineMode === 'hls') {
      if (hlsFallbackToGen && (video.adaptiveFormats.length > 0 || video.formatStreams.length > 0)) {
        return `/api/v1/stream/hls-gen/${encodeURIComponent(video.videoId)}/index.m3u8`;
      }
      if (video.hlsProxyUrl) {
        return video.hlsProxyUrl;
      }
      if (video.adaptiveFormats.length > 0 || video.formatStreams.length > 0) {
        return `/api/v1/stream/hls-gen/${encodeURIComponent(video.videoId)}/index.m3u8`;
      }
      return '';
    }
    if (engineMode === 'progressive') {
      const targetProg =
        video.formatStreams.find((f) => f.itag === selectedVideoItag) || video.formatStreams[0];
      if (!targetProg) return '';
      if (browserResolvedMode && targetProg.url) return targetProg.url;
      return `/latest_version?id=${encodeURIComponent(video.videoId)}&itag=${encodeURIComponent(targetProg.itag)}`;
    }
    if (engineMode === 'sync' && selectedVideoItag) {
      const track = video.adaptiveFormats.find((f) => f.itag === selectedVideoItag);
      if (browserResolvedMode && track?.url) return track.url;
      return `/latest_version?id=${encodeURIComponent(video.videoId)}&itag=${encodeURIComponent(selectedVideoItag)}`;
    }
    if (engineMode === 'relay' && selectedRelayUrl) {
      return selectedRelayUrl;
    }
    return '';
  }, [
    video,
    engineMode,
    selectedVideoItag,
    selectedAudioItag,
    selectedRelayUrl,
    browserResolvedMode,
    optMode,
    muxSeekOffsetSec,
    hlsFallbackToGen,
  ]);

  const activeAudioSrc = useMemo(() => {
    if (!video || engineMode !== 'sync' || !selectedAudioItag) return '';
    if (browserResolvedMode) {
      const track = video.adaptiveFormats.find((f) => f.itag === selectedAudioItag);
      if (track?.url) return track.url;
    }
    return `/latest_version?id=${encodeURIComponent(video.videoId)}&itag=${encodeURIComponent(selectedAudioItag)}`;
  }, [video, engineMode, selectedAudioItag, browserResolvedMode]);

  // External Invidious + Zernio living server auto-recovery function
  const runExternalAutoRecovery = async (): Promise<boolean> => {
    if (!video || recoveringExternal) return false;
    setRecoveringExternal(true);
    setAutoFallbackNote(
      '再生エラー自動復旧を実行中: 外部の生存 Invidious / Zernio / Piped サーバーを検索しています...',
    );
    try {
      const { resolved } = await recoverPlaybackFromExternalNodes(
        video.videoId,
        settings.customInvidiousUrl || streamCfg?.customUpstreamUrl || undefined,
        settings.customZernioUrl || undefined,
      );
      if (
        resolved &&
        (resolved.adaptiveFormats.length > 0 ||
          resolved.formatStreams.length > 0 ||
          resolved.hlsManifestUrl)
      ) {
        const updatedVideo: VideoResponse = {
          ...video,
          adaptiveFormats: resolved.adaptiveFormats.length ? resolved.adaptiveFormats : video.adaptiveFormats,
          formatStreams: resolved.formatStreams.length ? resolved.formatStreams : video.formatStreams,
          hlsManifestUrl: resolved.hlsManifestUrl || video.hlsManifestUrl,
          hlsProxyUrl: resolved.hlsProxyUrl || video.hlsProxyUrl,
          directStreamAvailable: true,
          streamErrorReason: undefined,
          upstreamSource: resolved.sourceHost,
        };
        setVideo(updatedVideo);
        updateClientVideoCache(video.videoId, updatedVideo, resolved.sourceHost);
        setMeta((prev) => (prev ? { ...prev, upstreamNode: resolved.sourceHost } : prev));
        setAutoFallbackNote(
          `再生エラー自動復旧成功: 生存中の外部 ${resolved.category?.toUpperCase() || 'NODE'} (${resolved.sourceHost}) へ接続して再生を復旧しました`,
        );
        applyResolvedTracks(updatedVideo, true, streamCfg, optMode, manualQuality);
        setStreamError(null);
        return true;
      }
      return false;
    } finally {
      setRecoveringExternal(false);
    }
  };

  // 7-server automatic fallback cascade + External Invidious/Zernio auto-recovery + Genuine Edu fallback
  const handleStreamError = () => {
    if (!video) return;

    if (videoRef.current && videoRef.current.currentTime > 0) {
      resumeTimeRef.current = videoRef.current.currentTime + (engineMode === 'mux' ? muxSeekOffsetSec : 0);
    }

    const candidates: { mode: StreamEngineMode; label: string }[] = [];
    if (video.formatStreams.length > 0 || video.adaptiveFormats.length > 0) {
      candidates.push({ mode: 'googlevideo', label: 'Googlevideo MP4 (IP偽装)' });
    }
    if (video.formatStreams.length > 0) {
      candidates.push({ mode: 'progressive', label: '標準 MP4' });
    }
    if (video.hlsProxyUrl || video.adaptiveFormats.length > 0 || video.formatStreams.length > 0) {
      candidates.push({ mode: 'hls', label: 'HLS (.m3u8)' });
    }
    if (videoTracks.length > 0 && audioTracks.length > 0) {
      candidates.push({ mode: 'sync', label: '4K 同期ストリーム' });
    }
    if (streamCfg?.ffmpegAvailable && videoTracks.length > 0 && audioTracks.length > 0) {
      candidates.push({ mode: 'mux', label: 'FFmpeg MP4結合' });
    }
    if (video.clientRelayStreams && video.clientRelayStreams.length > 0) {
      candidates.push({ mode: 'relay', label: '外部リレー直結' });
    }

    const next = candidates.find((c) => !triedModesRef.current.has(c.mode));
    if (next) {
      triedModesRef.current.add(next.mode);
      if ((next.mode === 'progressive' || next.mode === 'googlevideo') && video.formatStreams[0]) {
        const optProg = pickOptimalProgressiveTrack(video.formatStreams, envProfile, optMode, manualQuality);
        if (optProg) setSelectedVideoItag(optProg.itag);
      } else if ((next.mode === 'mux' || next.mode === 'sync') && videoTracks[0] && audioTracks[0]) {
        const optV = pickOptimalVideoTrack(videoTracks, envProfile, optMode, manualQuality);
        if (optV) setSelectedVideoItag(optV.itag);
        setSelectedAudioItag(audioTracks[0].itag);
      } else if (next.mode === 'relay' && !selectedRelayUrl && video.clientRelayStreams?.[0]) {
        setSelectedRelayUrl(video.clientRelayStreams[0].url);
      }
      setAutoFallbackNote(`自動フォールバック実行: ${next.label} サーバーへ切り替えました`);
      setEngineMode(next.mode);
      return;
    }

    if (!silentRefreshedRef.current) {
      silentRefreshedRef.current = true;
      setAutoFallbackNote('署名URLを更新して再試行しています...');
      loadVideo(video.videoId, true, true);
      return;
    }

    // All local engines failed -> Search & use live external Invidious + Zernio/Piped servers!
    if (settings.autoExternalRecovery && !externalRecoveryTriedRef.current) {
      externalRecoveryTriedRef.current = true;
      runExternalAutoRecovery().then((recoveredOk) => {
        if (!recoveredOk && !triedModesRef.current.has('edu-classroom')) {
          triedModesRef.current.add('edu-classroom');
          setAutoFallbackNote(
            '外部 Invidious / Zernio でも直接再生不可だったため、正規 Edu再生 (youtubeeducation.com) へ切り替えました',
          );
          setEngineMode('edu-classroom');
        }
      });
      return;
    }

    // Final guaranteed fallback for school / restricted terminals -> Genuine YouTube Education embed
    if (!triedModesRef.current.has('edu-classroom')) {
      triedModesRef.current.add('edu-classroom');
      setAutoFallbackNote(
        '直接ストリームが制限されている環境のため、正規 Edu再生 (youtubeeducation.com) へ自動フォールバックしました',
      );
      setEngineMode('edu-classroom');
      return;
    }

    setAutoFallbackNote(null);
    setStreamError(
      '全サーバーから直接ストリームを取得できませんでした。正規 Edu再生 (youtubeeducation.com) またはデバイス認証をご利用ください。',
    );
  };

  // Smooth, stall-free ±10s skip handler across ALL engines (Range, HLS, Sync, Mux)
  const performSkip = (deltaSec: number) => {
    const vEl = videoRef.current;
    if (!vEl) return;

    const currentLogical = vEl.currentTime + (engineMode === 'mux' ? muxSeekOffsetSec : 0);
    const maxDur = Number.isFinite(vEl.duration) && vEl.duration > 0 ? vEl.duration : (video?.lengthSeconds || 3600);
    const targetSec = Math.max(0, Math.min(maxDur - 0.5, currentLogical + deltaSec));

    if (skipBadgeTimerRef.current) window.clearTimeout(skipBadgeTimerRef.current);
    setSkipFeedback(`${deltaSec > 0 ? `+${deltaSec}` : deltaSec}秒 (${formatDuration(targetSec)})`);
    skipBadgeTimerRef.current = window.setTimeout(() => setSkipFeedback(null), 1200);

    // Check if target timestamp is already buffered locally (works instantly for all engines including mux!)
    let isBuffered = false;
    for (let i = 0; i < vEl.buffered.length; i++) {
      const localTarget = targetSec - (engineMode === 'mux' ? muxSeekOffsetSec : 0);
      if (localTarget >= vEl.buffered.start(i) && localTarget <= vEl.buffered.end(i)) {
        isBuffered = true;
        break;
      }
    }

    if (engineMode === 'mux' && !isBuffered) {
      // FFmpeg pipe stream cannot seek unbuffered bytes; restart mux at exact -ss timestamp
      resumeTimeRef.current = 0;
      setMuxSeekOffsetSec(Math.floor(targetSec));
      return;
    }

    const localTime = Math.max(0, targetSec - (engineMode === 'mux' ? muxSeekOffsetSec : 0));
    if (hlsRef.current) {
      vEl.currentTime = localTime;
      hlsRef.current.startLoad(localTime);
    } else {
      vEl.currentTime = localTime;
    }

    if (vEl.paused) {
      vEl.play().catch(() => {});
    }
  };

  // Keyboard shortcuts for smooth skipping (← / → / J / L) without interfering with text inputs
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (engineMode.startsWith('edu-')) return;

      if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') {
        e.preventDefault();
        performSkip(10);
      } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'j') {
        e.preventDefault();
        performSkip(-10);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineMode, muxSeekOffsetSec, video?.lengthSeconds]);

  // Attach hls.js in HLS mode with fast seek & automatic level selection
  useEffect(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const vEl = videoRef.current;
    if (!vEl || engineMode !== 'hls' || !activeVideoSrc) return;

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        maxBufferLength: 25,
        maxMaxBufferLength: 60,
        backBufferLength: 30,
        maxBufferHole: 0.5,
        nudgeMaxRetry: 6,
        startFragPrefetch: true,
        fragLoadingMaxRetry: 5,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 4,
      });
      hlsRef.current = hls;
      let recoveredMediaOnce = false;

      hls.loadSource(activeVideoSrc);
      hls.attachMedia(vEl);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (typeof manualQuality === 'number' && hls.levels.length > 0) {
          let bestIdx = 0;
          let bestDiff = Infinity;
          hls.levels.forEach((lvl, idx) => {
            const diff = Math.abs((lvl.height || 0) - manualQuality);
            if (diff < bestDiff) {
              bestDiff = diff;
              bestIdx = idx;
            }
          });
          hls.currentLevel = bestIdx;
        }
        if (resumeTimeRef.current > 1) {
          vEl.currentTime = resumeTimeRef.current;
          resumeTimeRef.current = 0;
        }
        vEl.playbackRate = playbackRate;
        vEl.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMediaOnce) {
          recoveredMediaOnce = true;
          hls.recoverMediaError();
          return;
        }
        hls.destroy();
        hlsRef.current = null;
        if (!hlsFallbackToGen && video && (video.adaptiveFormats.length > 0 || video.formatStreams.length > 0)) {
          setHlsFallbackToGen(true);
          return;
        }
        handleStreamError();
      });
    } else if (vEl.canPlayType('application/vnd.apple.mpegurl')) {
      vEl.src = activeVideoSrc;
    } else {
      handleStreamError();
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineMode, activeVideoSrc]);

  // Synchronize <video> and <audio> in Dual-Track Sync mode WITHOUT seek deadlocks
  useEffect(() => {
    const vEl = videoRef.current;
    const aEl = audioRef.current;
    if (!vEl || !aEl || engineMode !== 'sync') return;

    const onPlay = () => {
      if (Math.abs(aEl.currentTime - vEl.currentTime) > 0.2) {
        aEl.currentTime = vEl.currentTime;
      }
      aEl.playbackRate = vEl.playbackRate;
      aEl.play().catch(() => {});
    };
    const onPause = () => aEl.pause();
    const onSeeking = () => {
      aEl.pause();
    };
    const onSeeked = () => {
      aEl.currentTime = vEl.currentTime;
      aEl.playbackRate = vEl.playbackRate;
      if (!vEl.paused) {
        aEl.play().catch(() => {});
      }
    };
    const onWaiting = () => aEl.pause();
    const onPlaying = () => {
      if (Math.abs(aEl.currentTime - vEl.currentTime) > 0.25) {
        aEl.currentTime = vEl.currentTime;
      }
      aEl.playbackRate = vEl.playbackRate;
      aEl.play().catch(() => {});
    };
    const onRateChange = () => {
      aEl.playbackRate = vEl.playbackRate;
    };
    const onTimeUpdate = () => {
      if (vEl.seeking || aEl.seeking || vEl.paused) return;
      if (Math.abs(aEl.currentTime - vEl.currentTime) > 0.35) {
        aEl.currentTime = vEl.currentTime;
      }
    };

    vEl.addEventListener('play', onPlay);
    vEl.addEventListener('pause', onPause);
    vEl.addEventListener('seeking', onSeeking);
    vEl.addEventListener('seeked', onSeeked);
    vEl.addEventListener('waiting', onWaiting);
    vEl.addEventListener('playing', onPlaying);
    vEl.addEventListener('ratechange', onRateChange);
    vEl.addEventListener('timeupdate', onTimeUpdate);

    return () => {
      vEl.removeEventListener('play', onPlay);
      vEl.removeEventListener('pause', onPause);
      vEl.removeEventListener('seeking', onSeeking);
      vEl.removeEventListener('seeked', onSeeked);
      vEl.removeEventListener('waiting', onWaiting);
      vEl.removeEventListener('playing', onPlaying);
      vEl.removeEventListener('ratechange', onRateChange);
      vEl.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, [engineMode, selectedVideoItag, selectedAudioItag]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackRate;
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  // Clean up stall watchdog on unmount or video switch
  useEffect(() => {
    return () => {
      if (stallTimerRef.current) window.clearTimeout(stallTimerRef.current);
      if (skipBadgeTimerRef.current) window.clearTimeout(skipBadgeTimerRef.current);
    };
  }, [videoId]);

  const clearStallWatchdog = () => {
    if (stallTimerRef.current) {
      window.clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  };

  const armStallWatchdog = () => {
    clearStallWatchdog();
    const vEl = videoRef.current;
    if (!vEl || vEl.paused) return;
    const tAtArm = vEl.currentTime;
    stallTimerRef.current = window.setTimeout(() => {
      const curEl = videoRef.current;
      if (!curEl || curEl.paused) return;
      if (Math.abs(curEl.currentTime - tAtArm) < 0.05 && curEl.readyState < 3) {
        if (engineMode === 'hls' && hlsRef.current) {
          hlsRef.current.startLoad(curEl.currentTime);
        } else if (engineMode === 'mux') {
          const target = Math.floor(curEl.currentTime + muxSeekOffsetSec);
          setMuxSeekOffsetSec(target);
        } else {
          // Small nudge triggers Range re-request without killing playback
          curEl.currentTime = Math.max(0, curEl.currentTime + 0.04);
          curEl.play().catch(() => {});
        }
      }
    }, 3500);
  };

  const handleLoadUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const extracted = extractVideoId(inputId);
    if (extracted) onSelectVideo(extracted);
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingConfig(true);
    try {
      const res = await probeApi<StreamConfigStatus>('/api/v1/config/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cookies: cookieInput,
          customUpstreamUrl: upstreamInput,
          outboundProxyUrl: proxyInput,
        }),
      });
      setStreamCfg(res.data);
      setShowConfig(false);
      await loadVideo(videoId, true);
    } finally {
      setSavingConfig(false);
    }
  };

  const handleStartDeviceAuth = async () => {
    setStartingAuth(true);
    try {
      const res = await probeApi<YouTubeAuthStatus>('/api/v1/auth/youtube/start', {
        method: 'POST',
      });
      setAuthState(res.data);
      if (res.data.status === 'authorized') {
        await loadConfig();
        await loadVideo(videoId, true);
      }
    } catch (err) {
      setAuthState({
        status: 'error',
        error: err instanceof Error ? err.message : '認証コードの発行に失敗しました',
      });
    } finally {
      setStartingAuth(false);
    }
  };

  const handleLogoutDeviceAuth = async () => {
    try {
      await fetch('/api/v1/auth/youtube/logout', { method: 'POST' });
      setAuthState({ status: 'idle' });
      await loadConfig();
      await loadVideo(videoId, true);
    } catch {
      // ignore
    }
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    window.setTimeout(() => setCopiedCode(false), 1800);
  };

  const handleDownload = (dlMode: 'mux' | 'progressive' | 'audio') => {
    if (!video) return;
    setShowDownloadMenu(false);

    if (browserResolvedMode && dlMode === 'audio' && audioTracks[0]?.url) {
      triggerDirectDownload(audioTracks[0].url, `${video.videoId}.m4a`);
      return;
    }

    const qs = new URLSearchParams({ mode: dlMode });
    if (dlMode === 'mux') {
      if (selectedVideoItag) qs.set('v', selectedVideoItag);
      if (selectedAudioItag) qs.set('a', selectedAudioItag);
    } else if (dlMode === 'progressive') {
      const progItag = video.formatStreams[0]?.itag || selectedVideoItag;
      if (progItag) qs.set('v', progItag);
    } else if (dlMode === 'audio') {
      const aItag = selectedAudioItag || audioTracks[0]?.itag;
      if (aItag) qs.set('a', aItag);
    }

    const ext = dlMode === 'audio' ? 'm4a' : 'mp4';
    triggerDirectDownload(
      `/api/v1/download/${encodeURIComponent(video.videoId)}?${qs.toString()}`,
      `${video.videoId}.${ext}`,
    );
  };

  const isEduMode =
    engineMode === 'edu-classroom' ||
    engineMode === 'edu-kahoot' ||
    engineMode === 'edu-workspace';

  const activeEduUrl = useMemo(() => {
    const rawUrl =
      engineMode === 'edu-kahoot'
        ? eduConfig?.kahootUrl ||
          `https://www.youtubeeducation.com/embed/${encodeURIComponent(videoId)}?autoplay=1&controls=1&rel=0&playsinline=1&iv_load_policy=3&fs=1`
        : engineMode === 'edu-workspace'
          ? eduConfig?.nocookieUrl ||
            `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&controls=1&rel=0&playsinline=1`
          : eduConfig?.classroomUrl ||
            `https://www.youtubeeducation.com/embed/${encodeURIComponent(videoId)}?rel=0&playsinline=1&iv_load_policy=3&modestbranding=1`;

    try {
      const parsed = new URL(rawUrl);
      parsed.searchParams.set('hl', settings.targetLang);
      if (settings.autoTranslateEnabled && settings.translateCaptions) {
        parsed.searchParams.set('cc_load_policy', '1');
        parsed.searchParams.set('cc_lang_pref', settings.targetLang);
      } else {
        parsed.searchParams.delete('cc_load_policy');
        parsed.searchParams.delete('cc_lang_pref');
      }
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }, [engineMode, eduConfig, videoId, settings.autoTranslateEnabled, settings.translateCaptions, settings.targetLang]);

  const nextQueuedVideo = rankedRecommendations[0] || null;

  return (
    <div className="flex flex-col gap-6">
      {/* 上部アクション & 環境最適化プロファイルバー */}
      <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3.5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBackToExplorer}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span>探索へ戻る</span>
            </button>

            {meta && (
              <div className="hidden md:flex items-center gap-2 font-mono text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                <span>{meta.upstreamNode}</span>
                <span aria-hidden="true">·</span>
                <span className={meta.cacheStatus === 'HIT' ? 'text-emerald-600 dark:text-emerald-400 font-medium' : ''}>
                  {meta.cacheStatus === 'HIT' ? 'キャッシュHIT' : '新規取得'}
                </span>
                <span aria-hidden="true">·</span>
                <span>{meta.latencyMs.toFixed(2)} ms</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-1 sm:max-w-xl justify-end">
            <form onSubmit={handleLoadUrlSubmit} className="flex items-center gap-2 flex-1">
              <input
                type="text"
                value={inputId}
                onChange={(e) => setInputId(e.target.value)}
                placeholder="動画ID または YouTube URL (例: aqz-KE-bpKQ)"
                className="h-9 flex-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-3 font-mono text-xs text-zinc-900 dark:text-zinc-100 focus:border-blue-600 focus:outline-none"
              />
              <button
                type="submit"
                className="h-9 rounded-lg bg-blue-600 px-3.5 text-xs font-semibold text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
              >
                読込
              </button>
            </form>

            <button
              type="button"
              onClick={() => setShowConfig((s) => !s)}
              className={`flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                showConfig ||
                streamCfg?.hasCookies ||
                streamCfg?.customUpstreamUrl ||
                streamCfg?.outboundProxyUrl ||
                streamCfg?.oauthAuthorized
                  ? 'border-blue-600/50 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400'
                  : 'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              <Settings2 className="h-3.5 w-3.5" />
              <span>接続設定</span>
            </button>
          </div>
        </div>

        {/* サーバー戦略プロファイル切替 & 死活監視クイックバー */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-zinc-100 dark:border-zinc-800/80">
          <div className="flex items-center gap-1 overflow-x-auto rounded-lg bg-zinc-100 dark:bg-zinc-950 p-1">
            {OPTIMIZATION_PROFILES.map((p) => {
              const active = optMode === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleProfileChange(p.id)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-white shadow-xs'
                      : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => checkLiveServers(true)}
              disabled={checkingLive}
              className="flex items-center gap-1.5 font-mono text-xs text-zinc-600 dark:text-zinc-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors tabular-nums"
              title="外部 Invidious / Zernio / 7サーバーの死活を再確認"
            >
              <Activity className={`h-3.5 w-3.5 text-emerald-500 ${checkingLive ? 'animate-pulse' : ''}`} />
              <span>
                {liveSummary
                  ? `死活: 生存${liveSummary.alive} · 遅延${liveSummary.degraded} · 停止${liveSummary.dead}`
                  : '死活確認中...'}
              </span>
            </button>
            <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-700">|</span>
            <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
              {envProfile.summaryText}
            </span>
          </div>
        </div>
      </div>

      {/* ストリーム接続設定パネル */}
      {showConfig && (
        <div className="flex flex-col gap-5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-zinc-100 dark:border-zinc-800">
            <div>
              <h2 className="text-sm font-semibold text-zinc-950 dark:text-white">
                4K 生ストリーム解除・IP偽装ルーティング設定
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                出口プロキシ設定や YouTube デバイス認証を行うと、Googlevideo MP4 / FFmpeg 4K60 / HLS の全機能が制限なく利用できます。
              </p>
            </div>
            {streamCfg && (
              <div className="flex items-center gap-2 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                <span>OAuth: {streamCfg.oauthAuthorized ? '認証済み' : '未認証'}</span>
                <span aria-hidden="true">·</span>
                <span>POトークン: {streamCfg.poTokenReady ? '有効' : '待機中'}</span>
                <span aria-hidden="true">·</span>
                <span>FFmpeg: {streamCfg.ffmpegAvailable ? '利用可能' : '未検出'}</span>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  <span className="text-xs font-semibold text-zinc-950 dark:text-white">
                    方法1（推奨・一番確実）: YouTube TV デバイス認証でサーバーIP制限を解除
                  </span>
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  コードを発行して Google 公式ページで承認するだけで、Cookie コピー不要でサーバーが 4K/60fps ストリームを直接解読できるようになります。
                </p>
              </div>

              {authState.status === 'authorized' || streamCfg?.oauthAuthorized ? (
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    認証済み (4K/1080p 有効)
                  </span>
                  <button
                    type="button"
                    onClick={handleLogoutDeviceAuth}
                    className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 whitespace-nowrap"
                  >
                    認証解除
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleStartDeviceAuth}
                  disabled={startingAuth}
                  className="rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  {startingAuth ? 'コード発行中...' : '認証コードを発行'}
                </button>
              )}
            </div>

            {authState.status === 'pending' && authState.userCode && (
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-zinc-200 dark:border-zinc-800 text-xs">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-zinc-600 dark:text-zinc-300">認証コード:</span>
                  <code className="rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 px-2.5 py-1 font-mono text-sm font-bold tracking-wider text-zinc-950 dark:text-white">
                    {authState.userCode}
                  </code>
                  <button
                    type="button"
                    onClick={() => handleCopyCode(authState.userCode || '')}
                    className="flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    {copiedCode ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                    <span>{copiedCode ? 'コピー済' : 'コピー'}</span>
                  </button>
                  <span className="text-zinc-500 dark:text-zinc-400">
                    承認待機中（完了後自動で4K再生に切り替わります）
                  </span>
                </div>
                <a
                  href={authState.verificationUrl || 'https://www.google.com/device'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 dark:bg-white px-3 py-1.5 font-semibold text-white dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-zinc-200 whitespace-nowrap"
                >
                  <span>google.com/device を開く</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            )}

            {authState.status === 'error' && authState.error && (
              <p className="text-xs font-mono text-red-600 dark:text-red-400">{authState.error}</p>
            )}
          </div>

          <form onSubmit={handleSaveConfig} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <label className="flex flex-col gap-1.5 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  出口プロキシ URL（HTTP / HTTPS / SOCKS5 でIP変更）
                </span>
                <input
                  type="text"
                  value={proxyInput}
                  onChange={(e) => setProxyInput(e.target.value)}
                  placeholder="http://user:pass@proxy:8080 または socks5://..."
                  className="h-10 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-3 font-mono text-xs text-zinc-900 dark:text-zinc-100 focus:border-blue-600 focus:outline-none"
                />
              </label>

              <label className="flex flex-col gap-1.5 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  YouTube Cookie ヘッダー（任意・メモリ内保持）
                </span>
                <input
                  type="password"
                  value={cookieInput}
                  onChange={(e) => setCookieInput(e.target.value)}
                  placeholder="VISITOR_INFO1_LIVE=...; SAPISID=..."
                  className="h-10 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-3 font-mono text-xs text-zinc-900 dark:text-zinc-100 focus:border-blue-600 focus:outline-none"
                />
              </label>

              <label className="flex flex-col gap-1.5 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  カスタム Invidious 上流ノード URL（任意）
                </span>
                <input
                  type="url"
                  value={upstreamInput}
                  onChange={(e) => setUpstreamInput(e.target.value)}
                  placeholder="https://your-invidious-instance.example"
                  className="h-10 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-3 font-mono text-xs text-zinc-900 dark:text-zinc-100 focus:border-blue-600 focus:outline-none"
                />
              </label>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowConfig(false)}
                className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                閉じる
              </button>
              <button
                type="submit"
                disabled={savingConfig}
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {savingConfig ? '適用中...' : '設定を保存して再取得'}
              </button>
            </div>
          </form>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 p-4">
          <p className="text-sm font-medium text-red-700 dark:text-red-400">{error}</p>
          <button
            type="button"
            onClick={() => loadVideo(videoId, true)}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 transition-colors whitespace-nowrap shrink-0"
          >
            再試行
          </button>
        </div>
      )}

      {/* メイン 2カラム シアター */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 flex flex-col gap-5">
          {/* ビューポート: HTML5 Video または Edu再生 (Google Classroom / Kahoot!) */}
          <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 bg-black">
            {loading || resolvingBrowser ? (
              <div className="flex h-full w-full items-center justify-center bg-zinc-900 font-mono text-xs text-zinc-400">
                {resolvingBrowser
                  ? '7サーバー自動フォールバック ＆ ブラウザIP経路探索中...'
                  : '環境最適化ストリームと Edu埋め込み情報を解決中...'}
              </div>
            ) : isEduMode ? (
              <iframe
                key={`${videoId}-${engineMode}`}
                src={activeEduUrl}
                title={video?.title || `Edu Player ${videoId}`}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
                className="h-full w-full border-0 bg-black"
              />
            ) : activeVideoSrc ? (
              <>
                <video
                  ref={videoRef}
                  key={`${video?.videoId || videoId}-${engineMode}-${engineMode === 'hls' ? (hlsFallbackToGen ? 'hlsgen' : 'hls') : activeVideoSrc}`}
                  src={engineMode === 'hls' && Hls.isSupported() ? undefined : activeVideoSrc}
                  controls
                  autoPlay
                  playsInline
                  preload="auto"
                  poster={`/api/v1/thumbnail/${videoId}/maxresdefault`}
                  onError={handleStreamError}
                  onWaiting={armStallWatchdog}
                  onSeeking={armStallWatchdog}
                  onSeeked={clearStallWatchdog}
                  onPlaying={clearStallWatchdog}
                  onLoadedMetadata={(e) => {
                    const el = e.currentTarget;
                    if (resumeTimeRef.current > 1 && engineMode !== 'mux') {
                      el.currentTime = resumeTimeRef.current;
                      resumeTimeRef.current = 0;
                    }
                    el.playbackRate = playbackRate;
                  }}
                  onCanPlay={() => {
                    clearStallWatchdog();
                    setStreamError(null);
                  }}
                  onEnded={() => {
                    if (autoPlayNext && nextQueuedVideo) {
                      onSelectVideo(nextQueuedVideo.videoId);
                    }
                  }}
                  className="h-full w-full object-contain bg-black"
                >
                  {settings.autoTranslateEnabled && settings.translateCaptions && (
                    <track
                      kind="subtitles"
                      label={`自動翻訳字幕 (${settings.targetLang.toUpperCase()})`}
                      srcLang={settings.targetLang}
                      src={`/api/v1/captions/${encodeURIComponent(video?.videoId || videoId)}?lang=${encodeURIComponent(settings.targetLang)}`}
                      default
                    />
                  )}
                </video>
                {engineMode === 'sync' && activeAudioSrc && (
                  <audio
                    ref={audioRef}
                    key={activeAudioSrc}
                    src={activeAudioSrc}
                    preload="auto"
                    onError={handleStreamError}
                  />
                )}
                {skipFeedback && (
                  <div className="pointer-events-none absolute top-4 right-4 rounded-lg bg-zinc-950/85 px-3 py-1.5 font-mono text-xs font-semibold text-white tabular-nums">
                    {skipFeedback}
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-zinc-950 p-6 text-center">
                <p className="text-sm font-medium text-zinc-200">
                  直接ストリームを取得できませんでした。外部サーバー自動復旧または正規 Edu再生 (youtubeeducation.com) に切り替えられます。
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => runExternalAutoRecovery()}
                    disabled={recoveringExternal}
                    className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${recoveringExternal ? 'animate-spin' : ''}`} />
                    <span>{recoveringExternal ? '外部サーバー検索中...' : '外部 Invidious/Zernio 自動復旧'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEngineMode('edu-classroom')}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700"
                  >
                    <GraduationCap className="h-3.5 w-3.5" />
                    <span>正規 Edu再生 (youtubeeducation.com)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEngineMode('edu-kahoot')}
                    className="rounded-lg bg-zinc-800 px-4 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-700"
                  >
                    Kahoot! Edu再生
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Eduモード時の学校フィルタ別ドメイン切替バー (正規 youtubeeducation.com 使用) */}
          {isEduMode && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/70 dark:bg-emerald-950/20 px-4 py-2.5 text-xs text-emerald-900 dark:text-emerald-200">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">正規 Edu再生 (youtubeeducation.com):</span>
                <button
                  type="button"
                  onClick={() => setEngineMode('edu-classroom')}
                  className={`rounded px-2 py-1 font-medium transition-colors ${
                    engineMode === 'edu-classroom'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white/70 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-white'
                  }`}
                >
                  Classroom Edu (youtubeeducation.com)
                </button>
                <button
                  type="button"
                  onClick={() => setEngineMode('edu-kahoot')}
                  className={`rounded px-2 py-1 font-medium transition-colors ${
                    engineMode === 'edu-kahoot'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white/70 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-white'
                  }`}
                >
                  Kahoot! Edu (youtubeeducation.com)
                </button>
                <button
                  type="button"
                  onClick={() => setEngineMode('edu-workspace')}
                  className={`rounded px-2 py-1 font-medium transition-colors ${
                    engineMode === 'edu-workspace'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white/70 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-white'
                  }`}
                >
                  予備互換 (nocookie)
                </button>
                <button
                  type="button"
                  onClick={() => runExternalAutoRecovery()}
                  disabled={recoveringExternal}
                  className="rounded border border-blue-500/40 bg-blue-50 dark:bg-blue-950/40 px-2 py-1 font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 transition-colors"
                >
                  {recoveringExternal ? '復旧探索中...' : '外部Invidious/Zernioで再復旧'}
                </button>
              </div>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(activeEduUrl);
                  setCopiedEduUrl(true);
                  window.setTimeout(() => setCopiedEduUrl(false), 1500);
                }}
                className="inline-flex items-center gap-1 font-mono underline hover:opacity-80 whitespace-nowrap"
              >
                {copiedEduUrl ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                <span>{copiedEduUrl ? 'URLコピー済' : 'Edu URLコピー'}</span>
              </button>
            </div>
          )}

          {autoFallbackNote && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-950/20 px-4 py-2.5 text-xs text-blue-700 dark:text-blue-300">
              <span>{autoFallbackNote}</span>
            </div>
          )}

          {/* Bot確認・未解決時の一発解除案内バー */}
          {video && !isEduMode && (!video.directStreamAvailable || streamError) && (
            <div className="flex flex-col gap-3 rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 px-4 py-3.5 text-xs text-amber-900 dark:text-amber-200">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <p className="leading-relaxed">
                  {streamError || video.streamErrorReason}
                </p>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setEngineMode('edu-classroom')}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors whitespace-nowrap"
                  >
                    <GraduationCap className="h-3.5 w-3.5" />
                    <span>Edu再生へ切替</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleStartDeviceAuth}
                    disabled={startingAuth}
                    className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    <span>{startingAuth ? 'コード発行中...' : 'TV認証 (4K解除)'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowConfig(true)}
                    className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 transition-colors whitespace-nowrap"
                  >
                    IPプロキシ設定
                  </button>
                </div>
              </div>

              {authState.status === 'pending' && authState.userCode && (
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-amber-200 dark:border-amber-900/50">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span>認証コード:</span>
                    <code className="rounded bg-white dark:bg-zinc-900 border border-amber-300 dark:border-amber-800 px-2.5 py-1 font-mono text-sm font-bold tracking-wider text-zinc-950 dark:text-white">
                      {authState.userCode}
                    </code>
                    <button
                      type="button"
                      onClick={() => handleCopyCode(authState.userCode || '')}
                      className="inline-flex items-center gap-1 rounded border border-amber-300 dark:border-amber-800 bg-white/70 dark:bg-zinc-900/70 px-2 py-1 text-xs font-medium"
                    >
                      {copiedCode ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                      <span>{copiedCode ? 'コピー済' : 'コピー'}</span>
                    </button>
                    <span className="opacity-80">承認後、自動で4K再読込します</span>
                  </div>
                  <a
                    href={authState.verificationUrl || 'https://www.google.com/device'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 dark:bg-white px-3 py-1.5 font-semibold text-white dark:text-zinc-950 whitespace-nowrap"
                  >
                    <span>google.com/device でコード入力</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              )}
            </div>
          )}

          {/* ストリームエンジン + 手動高画質指定 + 10秒無停止スキップ + 連続再生バー */}
          {video && (
            <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 p-1">
                  {(video.formatStreams.length > 0 || video.adaptiveFormats.length > 0) && (
                    <button
                      type="button"
                      onClick={() => {
                        if (videoRef.current?.currentTime) {
                          resumeTimeRef.current = videoRef.current.currentTime;
                        }
                        triedModesRef.current.add('googlevideo');
                        setEngineMode('googlevideo');
                      }}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        engineMode === 'googlevideo'
                          ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-white shadow-xs'
                          : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                      }`}
                    >
                      Googlevideo MP4 (IP偽装)
                    </button>
                  )}

                  {streamCfg?.ffmpegAvailable && videoTracks.length > 0 && audioTracks.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        if (videoRef.current?.currentTime) {
                          setMuxSeekOffsetSec(Math.floor(videoRef.current.currentTime));
                        }
                        triedModesRef.current.add('mux');
                        setEngineMode('mux');
                      }}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        engineMode === 'mux'
                          ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-white shadow-xs'
                          : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                      }`}
                    >
                      MP4結合 (4K)
                    </button>
                  )}

                  {(video.hlsProxyUrl || video.adaptiveFormats.length > 0 || video.formatStreams.length > 0) && (
                    <button
                      type="button"
                      onClick={() => {
                        if (videoRef.current?.currentTime) {
                          resumeTimeRef.current = videoRef.current.currentTime;
                        }
                        triedModesRef.current.add('hls');
                        setHlsFallbackToGen(false);
                        setEngineMode('hls');
                      }}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        engineMode === 'hls'
                          ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-white shadow-xs'
                          : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                      }`}
                    >
                      HLS (.m3u8)
                    </button>
                  )}

                  {video.formatStreams.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        if (videoRef.current?.currentTime) {
                          resumeTimeRef.current = videoRef.current.currentTime;
                        }
                        triedModesRef.current.add('progressive');
                        setEngineMode('progressive');
                        setSelectedVideoItag(video.formatStreams[0].itag);
                      }}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        engineMode === 'progressive'
                          ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-white shadow-xs'
                          : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                      }`}
                    >
                      標準 MP4
                    </button>
                  )}

                  {videoTracks.length > 0 && audioTracks.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        if (videoRef.current?.currentTime) {
                          resumeTimeRef.current = videoRef.current.currentTime;
                        }
                        triedModesRef.current.add('sync');
                        if (!videoTracks.some((v) => v.itag === selectedVideoItag)) {
                          setSelectedVideoItag(videoTracks[0].itag);
                        }
                        if (!audioTracks.some((a) => a.itag === selectedAudioItag)) {
                          setSelectedAudioItag(audioTracks[0].itag);
                        }
                        setEngineMode('sync');
                      }}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        engineMode === 'sync'
                          ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-white shadow-xs'
                          : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                      }`}
                    >
                      4K同期
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setEngineMode('edu-classroom')}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      engineMode === 'edu-classroom' || engineMode === 'edu-workspace'
                        ? 'bg-emerald-600 text-white shadow-xs'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                  >
                    Edu (Classroom)
                  </button>

                  <button
                    type="button"
                    onClick={() => setEngineMode('edu-kahoot')}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      engineMode === 'edu-kahoot'
                        ? 'bg-emerald-600 text-white shadow-xs'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                    }`}
                  >
                    Edu (Kahoot!)
                  </button>

                  {video.clientRelayStreams && video.clientRelayStreams.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        triedModesRef.current.add('relay');
                        setEngineMode('relay');
                        if (!selectedRelayUrl && video.clientRelayStreams?.[0]) {
                          setSelectedRelayUrl(video.clientRelayStreams[0].url);
                        }
                      }}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        engineMode === 'relay'
                          ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-white shadow-xs'
                          : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                      }`}
                    >
                      外部リレー
                    </button>
                  )}
                </div>

                {/* 右側ツール群: 手動高画質 + 速度 + ダウンロード + 検査 */}
                <div className="relative flex flex-wrap items-center gap-2">
                  <select
                    value={String(manualQuality)}
                    onChange={(e) => handleManualQualityChange(e.target.value)}
                    aria-label="手動・自動画質選択"
                    className="h-8 rounded-lg border border-blue-500/40 dark:border-blue-500/40 bg-blue-50/60 dark:bg-blue-950/30 px-2.5 font-mono text-xs font-semibold text-blue-800 dark:text-blue-200"
                  >
                    {MANUAL_QUALITY_OPTIONS.map((q) => (
                      <option key={String(q.value)} value={String(q.value)}>
                        {q.label}
                      </option>
                    ))}
                  </select>

                  <div className="relative">
                    <button
                      type="button"
                      disabled={!video.directStreamAvailable && video.formatStreams.length === 0 && videoTracks.length === 0}
                      onClick={() => setShowDownloadMenu((s) => !s)}
                      className="flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 dark:bg-white px-3 text-xs font-semibold text-white dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>ダウンロード</span>
                    </button>

                    {showDownloadMenu && (
                      <div className="absolute right-0 top-9 z-30 w-64 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-1.5 shadow-xl">
                        <button
                          type="button"
                          onClick={() => handleDownload('mux')}
                          className="flex w-full flex-col rounded-md px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                          <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                            高画質 MP4 (映像+音声結合)
                          </span>
                          <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                            選択中画質 ({videoTracks.find((t) => t.itag === selectedVideoItag)?.qualityLabel || '最高画質'})
                          </span>
                        </button>

                        {video.formatStreams.length > 0 && (
                          <button
                            type="button"
                            onClick={() => handleDownload('progressive')}
                            className="flex w-full flex-col rounded-md px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          >
                            <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                              標準 MP4 (単一ファイル)
                            </span>
                            <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                              互換性重視 · 高速保存
                            </span>
                          </button>
                        )}

                        {audioTracks.length > 0 && (
                          <button
                            type="button"
                            onClick={() => handleDownload('audio')}
                            className="flex w-full flex-col rounded-md px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          >
                            <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                              音声のみ (M4A / WebM)
                            </span>
                            <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                              {Math.round((Number(audioTracks[0]?.bitrate) || 128000) / 1000)} kbps 高音質
                            </span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => runExternalAutoRecovery()}
                    disabled={recoveringExternal}
                    className="flex h-8 items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-50/60 dark:bg-emerald-950/30 px-2.5 text-xs font-medium text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100/80 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${recoveringExternal ? 'animate-spin' : ''}`} />
                    <span>{recoveringExternal ? '復旧中...' : '外部自動復旧'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onInspectInApi(`/api/kuro/auto-fallback/${video.videoId}`)}
                    className="flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Code2 className="h-3.5 w-3.5" />
                    <span>JSON 検査</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => loadVideo(video.videoId, true)}
                    className="flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>再取得</span>
                  </button>
                </div>
              </div>

              {/* トラック詳細・±10秒瞬時スキップ・先読み次動画コントローラ */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-zinc-100 dark:border-zinc-800/80">
                <div className="flex flex-wrap items-center gap-2">
                  {!isEduMode && (
                    <>
                      <button
                        type="button"
                        onClick={() => performSkip(-10)}
                        title="10秒戻す (← / J)"
                        className="flex h-8 items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-2.5 font-mono text-xs font-medium text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap"
                      >
                        <Rewind className="h-3.5 w-3.5" />
                        <span>-10秒</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => performSkip(10)}
                        title="10秒進める (→ / L)"
                        className="flex h-8 items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-2.5 font-mono text-xs font-medium text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap"
                      >
                        <span>+10秒</span>
                        <FastForward className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}

                  {(engineMode === 'sync' || engineMode === 'mux') && videoTracks.length > 0 && (
                    <select
                      value={selectedVideoItag}
                      onChange={(e) => {
                        if (videoRef.current?.currentTime) {
                          if (engineMode === 'mux') {
                            setMuxSeekOffsetSec(Math.floor(videoRef.current.currentTime));
                          } else {
                            resumeTimeRef.current = videoRef.current.currentTime;
                          }
                        }
                        setSelectedVideoItag(e.target.value);
                      }}
                      aria-label="詳細映像トラック選択"
                      className="h-8 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-2.5 font-mono text-xs text-zinc-800 dark:text-zinc-200"
                    >
                      {videoTracks.map((f, idx) => (
                        <option key={`${f.itag}-${idx}`} value={f.itag}>
                          {f.qualityLabel || f.resolution} {f.fps ? `${f.fps}fps` : ''} ({f.container}/{f.encoding.split('.')[0]})
                        </option>
                      ))}
                    </select>
                  )}

                  {(engineMode === 'progressive' || engineMode === 'googlevideo') && video.formatStreams.length > 0 && (
                    <select
                      value={selectedVideoItag}
                      onChange={(e) => {
                        if (videoRef.current?.currentTime) {
                          resumeTimeRef.current = videoRef.current.currentTime;
                        }
                        setSelectedVideoItag(e.target.value);
                      }}
                      aria-label="MP4画質選択"
                      className="h-8 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-2.5 font-mono text-xs text-zinc-800 dark:text-zinc-200"
                    >
                      {video.formatStreams.map((f, idx) => (
                        <option key={`${f.itag}-${idx}`} value={f.itag}>
                          {f.qualityLabel || f.resolution} ({f.container})
                        </option>
                      ))}
                    </select>
                  )}

                  {engineMode === 'relay' && video.clientRelayStreams && (
                    <select
                      value={selectedRelayUrl}
                      onChange={(e) => setSelectedRelayUrl(e.target.value)}
                      aria-label="リレー画質選択"
                      className="h-8 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-2.5 font-mono text-xs text-zinc-800 dark:text-zinc-200"
                    >
                      {video.clientRelayStreams.map((r, idx) => (
                        <option key={`${r.url}-${idx}`} value={r.url}>
                          {r.label} ({r.host})
                        </option>
                      ))}
                    </select>
                  )}

                  {!isEduMode && (
                    <select
                      value={playbackRate}
                      onChange={(e) => setPlaybackRate(Number(e.target.value))}
                      aria-label="再生速度"
                      className="h-8 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-2 font-mono text-xs text-zinc-800 dark:text-zinc-200"
                    >
                      {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                        <option key={rate} value={rate}>
                          {rate}x
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAutoPlayNext((v) => !v)}
                    className={`h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors whitespace-nowrap ${
                      autoPlayNext
                        ? 'border-emerald-500/40 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                        : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400'
                    }`}
                  >
                    連続再生: {autoPlayNext ? 'ON' : 'OFF'}
                  </button>

                  {nextQueuedVideo && (
                    <button
                      type="button"
                      onClick={() => onSelectVideo(nextQueuedVideo.videoId)}
                      onMouseEnter={() => prefetchVideo(nextQueuedVideo.videoId)}
                      className="flex h-8 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-700 transition-colors whitespace-nowrap"
                    >
                      <SkipForward className="h-3.5 w-3.5" />
                      <span>次の動画へ (先読み済)</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 動画詳細カード (自動翻訳切替対応) */}
          {video && (
            <div className="flex flex-col gap-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <h2 className="text-xl font-bold leading-snug text-zinc-950 dark:text-white [text-wrap:balance]">
                    {!showOriginalText && translatedTitle ? translatedTitle : video.title}
                  </h2>
                  {!showOriginalText && translatedTitle && (
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">
                      原文: {video.title}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {(translatedTitle || translatedDesc || Object.keys(translatedComments).length > 0) && (
                    <button
                      type="button"
                      onClick={() => setShowOriginalText((v) => !v)}
                      className="flex items-center gap-1.5 rounded-lg border border-blue-500/40 bg-blue-50/70 dark:bg-blue-950/30 px-2.5 py-1 text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 transition-colors whitespace-nowrap"
                    >
                      <Languages className="h-3.5 w-3.5" />
                      <span>{showOriginalText ? '翻訳を表示' : '原文を表示'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => updateSettings({ autoTranslateEnabled: !settings.autoTranslateEnabled })}
                    className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                      settings.autoTranslateEnabled
                        ? 'border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                        : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <span>自動翻訳: {settings.autoTranslateEnabled ? settings.targetLang.toUpperCase() : 'OFF'}</span>
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-zinc-100 dark:border-zinc-800">
                <div className="flex items-center gap-3">
                  {video.authorThumbnails?.[0]?.url ? (
                    <img
                      src={video.authorThumbnails[0].url}
                      alt={video.author}
                      referrerPolicy="no-referrer"
                      className="h-10 w-10 rounded-full object-cover bg-zinc-200 dark:bg-zinc-800"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-800 font-semibold text-sm text-zinc-700 dark:text-zinc-200">
                      {video.author.charAt(0).toUpperCase()}
                    </div>
                  )}

                  <div className="flex flex-col">
                    {video.authorId ? (
                      <button
                        type="button"
                        onClick={() => onSelectChannel(video.authorId)}
                        className="text-left text-sm font-semibold text-zinc-900 dark:text-zinc-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                      >
                        {video.author}
                      </button>
                    ) : (
                      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {video.author}
                      </span>
                    )}
                    {video.subCountText && (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                        {video.subCountText}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300 tabular-nums">
                  <span className="font-medium">
                    {video.viewCountText || `${formatCompactNumber(video.viewCount)} 回視聴`}
                  </span>
                  {video.publishedText && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{video.publishedText}</span>
                    </>
                  )}
                  {video.maxResolution && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono font-semibold text-blue-600 dark:text-blue-400">
                        {video.maxResolution}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {video.description && (
                <div className="flex flex-col gap-2">
                  <p
                    className={`whitespace-pre-wrap text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 ${
                      showDesc ? '' : 'line-clamp-3'
                    }`}
                  >
                    {!showOriginalText && translatedDesc ? translatedDesc : video.description}
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowDesc((s) => !s)}
                    className="flex w-fit items-center gap-1 text-xs font-semibold text-zinc-900 dark:text-zinc-100 hover:text-blue-600 dark:hover:text-blue-400"
                  >
                    {showDesc ? (
                      <>
                        <span>折りたたむ</span>
                        <ChevronUp className="h-3.5 w-3.5" />
                      </>
                    ) : (
                      <>
                        <span>概要をすべて表示</span>
                        <ChevronDown className="h-3.5 w-3.5" />
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 適応ストリーム & コーデック一覧テーブル */}
          {video && (
            <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  適応型ストリーム・コーデック一覧
                </h3>
                <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                  {video.adaptiveFormats.length + video.formatStreams.length} ストリーム検出
                </span>
              </div>

              {video.adaptiveFormats.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
                        <th className="py-2 pr-3 font-medium">Itag</th>
                        <th className="py-2 pr-3 font-medium">解像度・品質</th>
                        <th className="py-2 pr-3 font-medium">コンテナ</th>
                        <th className="py-2 pr-3 font-medium">コーデック</th>
                        <th className="py-2 pr-3 text-right font-medium">ビットレート</th>
                        <th className="py-2 text-right font-medium">直接URL</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70 font-mono tabular-nums">
                      {video.adaptiveFormats.slice(0, 16).map((fmt, idx) => (
                        <tr key={`${fmt.itag}-${fmt.type}-${idx}`} className="h-10 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                          <td className="pr-3 text-zinc-700 dark:text-zinc-300">{fmt.itag}</td>
                          <td className="pr-3 font-semibold text-zinc-900 dark:text-zinc-100">
                            {fmt.qualityLabel || fmt.audioQuality || '音声'}
                            {fmt.fps ? ` ${fmt.fps}fps` : ''}
                          </td>
                          <td className="pr-3 text-zinc-600 dark:text-zinc-400">{fmt.container}</td>
                          <td className="pr-3 text-zinc-600 dark:text-zinc-400">{fmt.encoding}</td>
                          <td className="pr-3 text-right text-zinc-600 dark:text-zinc-400">
                            {fmt.bitrate ? `${Math.round(Number(fmt.bitrate) / 1000)} kbps` : '—'}
                          </td>
                          <td className="text-right">
                            <a
                              href={fmt.proxyUrl || fmt.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
                            >
                              <span>開く</span>
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  現在、生ストリームURLが未解決のため一覧は空ですが、上の「Edu (Classroom)」「Edu (Kahoot!)」ボタンまたはデバイス認証で再生できます。
                </p>
              )}
            </div>
          )}

          {/* コメント欄 */}
          {comments && (
            <div className="flex flex-col gap-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums">
                コメント ({comments.comments.length} 件)
              </h3>
              {comments.comments.length === 0 ? (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">コメントはありません。</p>
              ) : (
                <div className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
                  {comments.comments.slice(0, 15).map((c, idx) => (
                    <div key={`${c.commentId}-${idx}`} className="flex gap-3 py-3.5 first:pt-0 last:pb-0">
                      {c.authorThumbnails?.[0]?.url ? (
                        <img
                          src={c.authorThumbnails[0].url}
                          alt={c.author}
                          referrerPolicy="no-referrer"
                          className="h-8 w-8 rounded-full object-cover bg-zinc-200 dark:bg-zinc-800 shrink-0"
                        />
                      ) : (
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-200 dark:bg-zinc-800 text-xs font-semibold shrink-0">
                          {c.author.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className="flex flex-col gap-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                            {c.author}
                          </span>
                          {c.publishedText && (
                            <>
                              <span aria-hidden="true" className="text-zinc-400">·</span>
                              <span className="text-zinc-500 dark:text-zinc-400">{c.publishedText}</span>
                            </>
                          )}
                          {c.likeCount > 0 && (
                            <>
                              <span aria-hidden="true" className="text-zinc-400">·</span>
                              <span className="font-mono text-zinc-500 dark:text-zinc-400 tabular-nums">
                                {formatCompactNumber(c.likeCount)} いいね
                              </span>
                            </>
                          )}
                        </div>
                        <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words">
                          {!showOriginalText && translatedComments[c.commentId]
                            ? translatedComments[c.commentId]
                            : c.content}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 右サイドバー: 視聴傾向パーソナライズ関連動画キュー（自動先読み対応） */}
        <aside className="lg:col-span-4 flex flex-col gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <div className="flex flex-col gap-0.5 pb-2 border-b border-zinc-100 dark:border-zinc-800">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                関連動画キュー
              </h3>
              <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                {rankedRecommendations.length} 件
              </span>
            </div>
            <span className="text-[11px] text-blue-600 dark:text-blue-400">
              上位3件をバックグラウンド自動先読み中 · 視聴傾向で最適化
            </span>
          </div>

          {loading && (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex gap-3">
                  <div className="h-16 w-28 rounded-lg bg-zinc-200 dark:bg-zinc-800 animate-pulse shrink-0" />
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-3 w-full rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                    <div className="h-3 w-2/3 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && video && rankedRecommendations.length === 0 && (
            <p className="py-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
              関連動画を取得しています...
            </p>
          )}

          {!loading && video && rankedRecommendations.length > 0 && (
            <div className="flex flex-col gap-3">
              {rankedRecommendations.map((rec, idx) => (
                <button
                  key={`${rec.videoId}-${idx}`}
                  type="button"
                  onMouseEnter={() => prefetchVideo(rec.videoId)}
                  onClick={() => onSelectVideo(rec.videoId)}
                  className="group flex items-start gap-3 rounded-lg p-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
                >
                  <div className="relative h-18 w-32 overflow-hidden rounded-md bg-zinc-200 dark:bg-zinc-950 shrink-0">
                    <img
                      src={rec.videoThumbnails?.[0]?.url || `/api/v1/thumbnail/${rec.videoId}/hqdefault`}
                      alt={rec.title}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                    <span className="absolute bottom-1 right-1 rounded bg-zinc-950/85 px-1 py-0.5 font-mono text-[10px] text-white tabular-nums">
                      {formatDuration(rec.lengthSeconds)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="text-xs font-semibold leading-snug text-zinc-900 dark:text-zinc-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 line-clamp-2">
                      {!showOriginalText && translatedRecTitles[rec.videoId]
                        ? translatedRecTitles[rec.videoId]
                        : rec.title}
                    </span>
                    <span className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                      {rec.author}
                    </span>
                    <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
                      {rec.viewCountText}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
