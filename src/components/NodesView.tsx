import { useEffect, useMemo, useState } from 'react';
import { Activity, Globe, Lock, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import type {
  ClusterServerNode,
  InstanceNode,
  InvidiousStats,
  KuroEdgeShieldResponse,
  LiveServerCategory,
  LiveServersResponse,
  StreamConfigStatus,
} from '../types/invidious';
import { probeApi } from '../lib/api';
import { useAppSettings } from '../lib/appSettings';
import { probeExternalNodeFromBrowser } from '../lib/streamResolver';

interface BypassTestResult {
  blocked: boolean;
  originStatus: number;
  latencyMs: number;
  message: string;
}

export function NodesView() {
  const [settings] = useAppSettings();
  const [stats, setStats] = useState<InvidiousStats | null>(null);
  const [nodes, setNodes] = useState<InstanceNode[]>([]);
  const [clusterNodes, setClusterNodes] = useState<ClusterServerNode[]>([]);
  const [liveReport, setLiveReport] = useState<LiveServersResponse | null>(null);
  const [liveCategory, setLiveCategory] = useState<'all' | LiveServerCategory>('all');
  const [browserProbes, setBrowserProbes] = useState<
    Record<string, { reachable: boolean; latencyMs: number | null }>
  >({});
  const [probingLive, setProbingLive] = useState(false);

  const [streamCfg, setStreamCfg] = useState<StreamConfigStatus | null>(null);
  const [shield, setShield] = useState<KuroEdgeShieldResponse | null>(null);

  const [rateLimitInput, setRateLimitInput] = useState<number>(240);
  const [wafStrictInput, setWafStrictInput] = useState<boolean>(true);
  const [stripHeadersInput, setStripHeadersInput] = useState<boolean>(true);

  const [loading, setLoading] = useState(true);
  const [purging, setPurging] = useState(false);
  const [savingRules, setSavingRules] = useState(false);
  const [ruleSavedMsg, setRuleSavedMsg] = useState<string | null>(null);
  const [testingBypass, setTestingBypass] = useState(false);
  const [bypassResult, setBypassResult] = useState<BypassTestResult | null>(null);
  const [testingWaf, setTestingWaf] = useState(false);
  const [wafResult, setWafResult] = useState<{ blocked: boolean; status: number; detail: string } | null>(null);

  const loadShield = async () => {
    const shieldRes = await probeApi<KuroEdgeShieldResponse>('/api/kuro/edge-shield');
    setShield(shieldRes.data);
    setRateLimitInput(shieldRes.data.rules.rateLimitPerMinute);
    setWafStrictInput(shieldRes.data.rules.wafStrictMode);
    setStripHeadersInput(shieldRes.data.rules.stripClientHeaders);
  };

  const runLiveHealthCheck = async (refresh = true) => {
    setProbingLive(true);
    try {
      const qs = new URLSearchParams();
      if (refresh) qs.set('refresh', 'true');
      if (settings.customInvidiousUrl) qs.set('customInvidious', settings.customInvidiousUrl);
      if (settings.customZernioUrl) qs.set('customZernio', settings.customZernioUrl);
      const res = await probeApi<LiveServersResponse>(`/api/kuro/live-servers?${qs.toString()}`);
      setLiveReport(res.data);

      // Probe external HTTP endpoints concurrently from user's browser IP as well
      const extServers = res.data.servers.filter((s) => s.url.startsWith('http'));
      Promise.all(
        extServers.map(async (srv) => {
          const br = await probeExternalNodeFromBrowser(srv.url);
          return [srv.id, br] as const;
        }),
      ).then((entries) => {
        const map: Record<string, { reachable: boolean; latencyMs: number | null }> = {};
        for (const [id, result] of entries) map[id] = result;
        setBrowserProbes(map);
      });
    } finally {
      setProbingLive(false);
    }
  };

  const loadAll = async (refreshCluster = false) => {
    setLoading(true);
    try {
      const liveQs = new URLSearchParams();
      if (refreshCluster) liveQs.set('refresh', 'true');
      if (settings.customInvidiousUrl) liveQs.set('customInvidious', settings.customInvidiousUrl);
      if (settings.customZernioUrl) liveQs.set('customZernio', settings.customZernioUrl);

      const [statsRes, nodesRes, clusterRes, cfgRes, shieldRes, liveRes] = await Promise.all([
        probeApi<InvidiousStats>('/api/v1/stats'),
        probeApi<InstanceNode[]>('/api/v1/instances'),
        probeApi<ClusterServerNode[]>(
          `/api/kuro/cluster-nodes${refreshCluster ? '?refresh=true' : ''}`,
        ),
        probeApi<StreamConfigStatus>('/api/v1/config/stream'),
        probeApi<KuroEdgeShieldResponse>('/api/kuro/edge-shield'),
        probeApi<LiveServersResponse>(`/api/kuro/live-servers?${liveQs.toString()}`),
      ]);
      setStats(statsRes.data);
      setNodes(nodesRes.data);
      setClusterNodes(clusterRes.data);
      setStreamCfg(cfgRes.data);
      setShield(shieldRes.data);
      setLiveReport(liveRes.data);
      setRateLimitInput(shieldRes.data.rules.rateLimitPerMinute);
      setWafStrictInput(shieldRes.data.rules.wafStrictMode);
      setStripHeadersInput(shieldRes.data.rules.stripClientHeaders);

      const extServers = liveRes.data.servers.filter((s) => s.url.startsWith('http'));
      Promise.all(
        extServers.map(async (srv) => {
          const br = await probeExternalNodeFromBrowser(srv.url);
          return [srv.id, br] as const;
        }),
      ).then((entries) => {
        const map: Record<string, { reachable: boolean; latencyMs: number | null }> = {};
        for (const [id, result] of entries) map[id] = result;
        setBrowserProbes(map);
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.customInvidiousUrl, settings.customZernioUrl]);

  const filteredLiveServers = useMemo(() => {
    if (!liveReport) return [];
    if (liveCategory === 'all') return liveReport.servers;
    return liveReport.servers.filter((s) => s.category === liveCategory);
  }, [liveReport, liveCategory]);

  const handlePurgeCache = async () => {
    setPurging(true);
    try {
      await fetch('/api/v1/cache/purge', { method: 'POST' });
      const statsRes = await probeApi<InvidiousStats>('/api/v1/stats');
      setStats(statsRes.data);
    } finally {
      setPurging(false);
    }
  };

  const handleSaveRules = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingRules(true);
    setRuleSavedMsg(null);
    try {
      const clampedRate = Math.min(2000, Math.max(10, Number(rateLimitInput) || 240));
      await probeApi('/api/kuro/edge-shield/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rateLimitPerMinute: clampedRate,
          wafStrictMode: wafStrictInput,
          stripClientHeaders: stripHeadersInput,
        }),
      });
      await loadShield();
      setRuleSavedMsg('防御ルールを即時適用しました。');
    } finally {
      setSavingRules(false);
    }
  };

  const handleTestOriginBypass = async () => {
    setTestingBypass(true);
    setBypassResult(null);
    try {
      const res = await fetch('/api/kuro/edge-shield/test-origin-bypass', { method: 'POST' });
      const json = (await res.json()) as {
        blocked: boolean;
        originStatus: number;
        latencyMs: number;
        originResponse?: { error?: string };
      };
      setBypassResult({
        blocked: Boolean(json.blocked),
        originStatus: json.originStatus,
        latencyMs: json.latencyMs,
        message:
          json.originResponse?.error ||
          'Proxy署名ヘッダー (X-Kuro-Origin-Token) が無い直接アクセスをオリジンが拒否しました。',
      });
      await loadShield();
    } finally {
      setTestingBypass(false);
    }
  };

  const handleTestWafProbe = async () => {
    setTestingWaf(true);
    setWafResult(null);
    try {
      const res = await fetch('/api/v1/search?q=../../etc/passwd');
      const json = (await res.json().catch(() => ({}))) as { error?: string; shieldAction?: string };
      setWafResult({
        blocked: res.status === 403,
        status: res.status,
        detail:
          json.error ||
          (res.status === 403
            ? 'パストラバーサルをリバースプロキシ WAF が遮断しました。'
            : 'WAF 厳格検査がオフのため通過しました。'),
      });
      await loadShield();
    } finally {
      setTestingWaf(false);
    }
  };

  const actionLabel = (action: KuroEdgeShieldResponse['recentLogs'][number]['action']) => {
    switch (action) {
      case 'CACHE_HIT':
        return { text: 'キャッシュHIT', cls: 'text-emerald-600 dark:text-emerald-400' };
      case 'WAF_BLOCKED':
        return { text: 'WAF遮断', cls: 'text-red-600 dark:text-red-400' };
      case 'RATE_LIMITED':
        return { text: 'レート制限', cls: 'text-amber-600 dark:text-amber-400' };
      default:
        return { text: '許可・転送', cls: 'text-zinc-700 dark:text-zinc-300' };
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 4カラム 実測キャッシュ・プロキシ指標 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="flex flex-col gap-1 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            L1キャッシュヒット率
          </span>
          <span className="font-mono text-2xl font-semibold text-zinc-950 dark:text-white tabular-nums">
            {stats ? `${stats.performance.hitRatePercent}%` : '—'}
          </span>
          <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
            {stats ? `${stats.performance.cacheHits} HIT / ${stats.performance.cacheMisses} MISS` : '読込中...'}
          </span>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            平均ゲートウェイ応答時間
          </span>
          <span className="font-mono text-2xl font-semibold text-zinc-950 dark:text-white tabular-nums">
            {stats ? `${stats.performance.avgLatencyMs} ms` : '—'}
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Gzip圧縮済み JSON 応答
          </span>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            7サーバー・クラスタ稼働
          </span>
          <span className="font-mono text-2xl font-semibold text-emerald-600 dark:text-emerald-400 tabular-nums">
            {clusterNodes.length > 0
              ? `${clusterNodes.filter((n) => n.status === 'online').length} / ${clusterNodes.length} 稼働`
              : '—'}
          </span>
          <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
            安定型 3 · 高速型 2 · 高画質型 2
          </span>
        </div>

        <div className="flex flex-col gap-1 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            自前オリジン稼働状態
          </span>
          <span className="font-mono text-2xl font-semibold text-zinc-950 dark:text-white tabular-nums">
            {stats ? `${stats.performance.uptimeSeconds} 秒` : '—'}
          </span>
          <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
            {streamCfg ? `FFmpeg: ${streamCfg.ffmpegAvailable ? '稼働可' : 'なし'} · PO: ${streamCfg.poTokenReady ? '有効' : '待機'}` : '—'}
          </span>
        </div>
      </div>

      {/* 全サーバーリアルタイム死活監視 (自前7サーバー / 外部 Invidious / Zernio / Piped) */}
      <div className="flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 dark:border-zinc-800 px-5 py-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                全サーバー死活監視モニター (生存 / 遅延 / 停止)
              </h2>
            </div>
            <p className="font-mono text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
              {liveReport
                ? `生存 ${liveReport.summary.alive} · 遅延 ${liveReport.summary.degraded} · 停止 ${liveReport.summary.dead} (自前7: ${liveReport.summary.clusterAlive}/7 · Invidious: ${liveReport.summary.invidiousAlive} · Zernio: ${liveReport.summary.zernioAlive} · Piped: ${liveReport.summary.pipedAlive})`
                : '全サーバーの死活状態を確認中...'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div className="flex items-center gap-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 p-1 text-xs">
              {(
                [
                  { id: 'all', label: 'すべて' },
                  { id: 'self-cluster', label: '自前7' },
                  { id: 'invidious', label: 'Invidious' },
                  { id: 'zernio', label: 'Zernio' },
                  { id: 'piped', label: 'Piped' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setLiveCategory(tab.id)}
                  className={`rounded-md px-2.5 py-1 font-medium transition-colors whitespace-nowrap ${
                    liveCategory === tab.id
                      ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-white shadow-xs'
                      : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => runLiveHealthCheck(true)}
              disabled={probingLive}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${probingLive ? 'animate-spin' : ''}`} />
              <span>{probingLive ? '死活確認中...' : '全サーバー死活確認'}</span>
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 text-zinc-500 dark:text-zinc-400">
                <th className="py-2.5 px-5 font-medium">区分</th>
                <th className="py-2.5 px-4 font-medium">サーバー名 / ホスト</th>
                <th className="py-2.5 px-4 font-medium">サーバー側死活</th>
                <th className="py-2.5 px-4 font-medium">ブラウザ側疎通</th>
                <th className="py-2.5 px-4 font-medium">HTTP</th>
                <th className="py-2.5 px-4 font-medium">詳細</th>
                <th className="py-2.5 px-5 text-right font-medium">応答速度</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
              {!liveReport || filteredLiveServers.length === 0 ? (
                <tr className="h-12">
                  <td colSpan={7} className="px-5 text-center text-zinc-500 dark:text-zinc-400">
                    {liveReport ? '該当カテゴリのサーバーはありません。' : '各ノードの生死をリアルタイム確認中...'}
                  </td>
                </tr>
              ) : (
                filteredLiveServers.map((srv) => {
                  const br = browserProbes[srv.id];
                  const isExternal = srv.url.startsWith('http');
                  return (
                    <tr key={srv.id} className="h-11 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                      <td className="px-5 font-medium text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                        {srv.categoryLabel}
                      </td>
                      <td className="px-4">
                        <div className="flex flex-col">
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">{srv.name}</span>
                          <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 truncate max-w-[260px]">
                            {srv.url}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 whitespace-nowrap font-semibold">
                        <span
                          className={`inline-flex items-center gap-1.5 ${
                            srv.alive === 'alive'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : srv.alive === 'degraded'
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-red-600 dark:text-red-400'
                          }`}
                        >
                          <span
                            className={`h-2 w-2 rounded-full ${
                              srv.alive === 'alive'
                                ? 'bg-emerald-500'
                                : srv.alive === 'degraded'
                                  ? 'bg-amber-500'
                                  : 'bg-red-500'
                            }`}
                          />
                          {srv.alive === 'alive'
                            ? '生存 (ALIVE)'
                            : srv.alive === 'degraded'
                              ? '遅延・制限'
                              : '停止 (DEAD)'}
                        </span>
                      </td>
                      <td className="px-4 whitespace-nowrap font-mono">
                        {!isExternal ? (
                          <span className="text-emerald-600 dark:text-emerald-400">ローカル直結</span>
                        ) : br ? (
                          br.reachable ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                              <Globe className="h-3 w-3" />
                              生存 ({br.latencyMs}ms)
                            </span>
                          ) : (
                            <span className="text-zinc-500 dark:text-zinc-400">CORS不可/応答無</span>
                          )
                        ) : (
                          <span className="text-zinc-400">確認中...</span>
                        )}
                      </td>
                      <td className="px-4 font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                        {srv.statusCode ?? '—'}
                      </td>
                      <td className="px-4 text-zinc-600 dark:text-zinc-400 max-w-[220px] truncate">
                        {srv.note || srv.region}
                      </td>
                      <td className="px-5 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                        {srv.latencyMs !== null ? `${srv.latencyMs} ms` : 'タイムアウト'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 7サーバー自動フォールバック・クラスタ (安定型・高速型・高画質型) */}
      <div className="flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 dark:border-zinc-800 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              7サーバー自動フォールバック・クラスタ (/api/kuro/cluster-nodes)
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              安定型（学校端末・Classroom/Kahoot Edu対応）・高速型（Googlevideo IP偽装 Range）・高画質型（4K60 FFmpeg/HLS）の7系統をリアルタイム死活監視し自動フォールバックします。
            </p>
          </div>

          <button
            type="button"
            onClick={() => loadAll(true)}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>全7サーバー再計測</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 text-zinc-500 dark:text-zinc-400">
                <th className="py-2.5 px-5 font-medium">分類</th>
                <th className="py-2.5 px-4 font-medium">サーバー名</th>
                <th className="py-2.5 px-4 font-medium">方式・機能</th>
                <th className="py-2.5 px-4 font-medium">エンドポイント</th>
                <th className="py-2.5 px-4 font-medium">状態</th>
                <th className="py-2.5 px-5 text-right font-medium">応答速度</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
              {clusterNodes.length === 0 ? (
                <tr className="h-12">
                  <td colSpan={6} className="px-5 text-center text-zinc-500 dark:text-zinc-400">
                    7サーバーの死活状態を計測中...
                  </td>
                </tr>
              ) : (
                clusterNodes.map((srv) => (
                  <tr key={srv.id} className="h-11 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                    <td
                      className={`px-5 font-semibold whitespace-nowrap ${
                        srv.tier === 'stable'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : srv.tier === 'fast'
                            ? 'text-blue-600 dark:text-blue-400'
                            : 'text-amber-600 dark:text-amber-400'
                      }`}
                    >
                      {srv.tierLabel}
                    </td>
                    <td className="px-4 font-medium text-zinc-900 dark:text-zinc-100">
                      {srv.name}
                    </td>
                    <td className="px-4 text-zinc-600 dark:text-zinc-400">
                      {srv.protocol} · {srv.capabilities.join(' · ')}
                    </td>
                    <td className="px-4 font-mono text-zinc-600 dark:text-zinc-400">
                      {srv.endpoint}
                    </td>
                    <td className="px-4 whitespace-nowrap">
                      <span
                        className={`font-medium ${
                          srv.status === 'online'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : srv.status === 'degraded'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-red-600 dark:text-red-400'
                        }`}
                      >
                        {srv.status === 'online'
                          ? 'オンライン'
                          : srv.status === 'degraded'
                            ? '低速'
                            : 'オフライン'}
                      </span>
                    </td>
                    <td className="px-5 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                      {srv.latencyMs !== null ? `${srv.latencyMs} ms` : 'タイムアウト'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* リバースプロキシ防御 & オリジン隔離シールドパネル */}
      <div className="flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 dark:border-zinc-800 px-5 py-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                リバースプロキシ防御・自前オリジン隔離シールド (/api/kuro/edge-shield)
              </h2>
            </div>
            <p className="font-mono text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
              {shield
                ? `${shield.proxyAddress} → ${shield.originAddress} · 許可 ${shield.counters.allowed} · キャッシュHIT ${shield.counters.cacheHits} · WAF遮断 ${shield.counters.wafBlocked} · レート制限 ${shield.counters.rateLimited}`
                : 'プロキシ構成を読み込み中...'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleTestOriginBypass}
              disabled={testingBypass}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <Lock className="h-3.5 w-3.5 text-blue-500" />
              <span>{testingBypass ? '検証中...' : 'オリジン直アクセス遮断テスト'}</span>
            </button>

            <button
              type="button"
              onClick={handleTestWafProbe}
              disabled={testingWaf}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
              <span>{testingWaf ? '検証中...' : 'WAF 攻撃遮断テスト'}</span>
            </button>
          </div>
        </div>

        {(bypassResult || wafResult) && (
          <div className="flex flex-col gap-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 px-5 py-3 text-xs font-mono">
            {bypassResult && (
              <div className="flex flex-wrap items-center gap-2">
                <span className={bypassResult.blocked ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'font-semibold text-red-600 dark:text-red-400'}>
                  [オリジン隔離テスト HTTP {bypassResult.originStatus}]
                </span>
                <span className="text-zinc-700 dark:text-zinc-300">
                  {bypassResult.message} ({bypassResult.latencyMs.toFixed(2)} ms)
                </span>
              </div>
            )}
            {wafResult && (
              <div className="flex flex-wrap items-center gap-2">
                <span className={wafResult.blocked ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'font-semibold text-amber-600 dark:text-amber-400'}>
                  [WAF 攻撃遮断テスト HTTP {wafResult.status}]
                </span>
                <span className="text-zinc-700 dark:text-zinc-300">
                  {wafResult.detail}
                </span>
              </div>
            )}
          </div>
        )}

        <form
          onSubmit={handleSaveRules}
          className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 dark:border-zinc-800 px-5 py-3.5 text-xs"
        >
          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300">
              <span>レート制限 (req/分):</span>
              <input
                type="number"
                min={10}
                max={2000}
                value={rateLimitInput}
                onChange={(e) => setRateLimitInput(Number(e.target.value))}
                className="h-8 w-20 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-2 font-mono text-xs text-zinc-900 dark:text-zinc-100 tabular-nums focus:border-blue-500 focus:outline-none"
              />
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={wafStrictInput}
                onChange={(e) => setWafStrictInput(e.target.checked)}
                className="h-4 w-4 accent-blue-600"
              />
              <span>WAF 厳格検査 (XSS / SQLi / SSRF / Path Traversal)</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={stripHeadersInput}
                onChange={(e) => setStripHeadersInput(e.target.checked)}
                className="h-4 w-4 accent-blue-600"
              />
              <span>クライアント識別ヘッダー秘匿 (XFF / Cookie / Referer 除去)</span>
            </label>
          </div>

          <div className="flex items-center gap-3">
            {ruleSavedMsg && (
              <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                {ruleSavedMsg}
              </span>
            )}
            <button
              type="submit"
              disabled={savingRules}
              className="rounded-lg bg-zinc-900 dark:bg-white px-3.5 py-1.5 text-xs font-semibold text-white dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              {savingRules ? '保存中...' : '防御ルール適用'}
            </button>
          </div>
        </form>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 text-zinc-500 dark:text-zinc-400">
                <th className="py-2.5 px-5 font-medium">時刻 (UTC)</th>
                <th className="py-2.5 px-4 font-medium">リクエストパス</th>
                <th className="py-2.5 px-4 font-medium">マスク済みIP</th>
                <th className="py-2.5 px-4 font-medium">シールド判定</th>
                <th className="py-2.5 px-4 font-medium">ステータス</th>
                <th className="py-2.5 px-5 text-right font-medium">応答速度</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
              {!shield || shield.recentLogs.length === 0 ? (
                <tr className="h-12">
                  <td colSpan={6} className="px-5 text-center text-zinc-500 dark:text-zinc-400">
                    まだプロキシ経由の監査ログはありません。
                  </td>
                </tr>
              ) : (
                shield.recentLogs.slice(0, 12).map((entry) => {
                  const badge = actionLabel(entry.action);
                  const timeStr = entry.timestamp.slice(11, 19);
                  return (
                    <tr key={entry.id} className="h-10 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                      <td className="px-5 font-mono tabular-nums text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                        {timeStr}
                      </td>
                      <td className="px-4 font-mono text-zinc-900 dark:text-zinc-100 max-w-[360px] truncate">
                        <span className="font-semibold mr-1.5">{entry.method}</span>
                        <span>{entry.path}</span>
                        {entry.reason && (
                          <span className="ml-2 text-red-600 dark:text-red-400">({entry.reason})</span>
                        )}
                      </td>
                      <td className="px-4 font-mono tabular-nums text-zinc-600 dark:text-zinc-400">
                        {entry.clientIpMasked}
                      </td>
                      <td className={`px-4 font-medium whitespace-nowrap ${badge.cls}`}>
                        {badge.text}
                      </td>
                      <td className="px-4 font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                        {entry.statusCode}
                      </td>
                      <td className="px-5 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                        {entry.latencyMs.toFixed(2)} ms
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 外部 Invidious リレーノード実測一覧 */}
      <div className="flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 dark:border-zinc-800 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              上流 Invidious 公開リレー一覧
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              公開 Invidious ミラーの死活・往復レイテンシをリアルタイム計測しています。
            </p>
          </div>

          <button
            type="button"
            onClick={handlePurgeCache}
            disabled={purging}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{purging ? '消去中...' : 'L1キャッシュ消去'}</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 text-zinc-500 dark:text-zinc-400">
                <th className="py-2.5 px-5 font-medium">ノード / ホスト名</th>
                <th className="py-2.5 px-4 font-medium">リージョン</th>
                <th className="py-2.5 px-4 font-medium">バージョン</th>
                <th className="py-2.5 px-4 font-medium">状態</th>
                <th className="py-2.5 px-5 text-right font-medium">応答速度</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
              {loading && nodes.length === 0 ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="h-11">
                    <td colSpan={5} className="px-5">
                      <div className="h-4 w-full rounded bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
                    </td>
                  </tr>
                ))
              ) : (
                nodes.map((node) => (
                  <tr key={node.domain} className="h-11 hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                    <td className="px-5 font-mono font-medium text-zinc-900 dark:text-zinc-100">
                      {node.domain}
                    </td>
                    <td className="px-4 text-zinc-600 dark:text-zinc-400">{node.region}</td>
                    <td className="px-4 font-mono text-zinc-600 dark:text-zinc-400">
                      {node.version || '—'}
                    </td>
                    <td className="px-4">
                      <span
                        className={`font-medium ${
                          node.status === 'online'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : node.status === 'degraded'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-red-600 dark:text-red-400'
                        }`}
                      >
                        {node.status === 'online'
                          ? 'オンライン'
                          : node.status === 'degraded'
                            ? '低速・制限'
                            : 'オフライン'}
                      </span>
                    </td>
                    <td className="px-5 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300">
                      {node.latencyMs !== null ? `${node.latencyMs} ms` : 'タイムアウト'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
