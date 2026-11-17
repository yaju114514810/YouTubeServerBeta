import { useEffect, useState } from 'react';
import { Check, Copy, Play, Zap } from 'lucide-react';
import { formatBytes, probeApi } from '../lib/api';

interface ApiConsoleViewProps {
  initialEndpoint?: string;
}

interface EndpointPreset {
  id: string;
  group: 'custom' | 'standard';
  method: 'GET' | 'POST';
  label: string;
  template: string;
  defaultBody?: string;
  description: string;
}

const DEFAULT_BATCH_BODY = JSON.stringify(
  {
    ids: ['aqz-KE-bpKQ', 'uT_hKGxSoSY', 'LXb3EKWsInQ'],
  },
  null,
  2,
);

const PRESETS: EndpointPreset[] = [
  {
    id: 'kuro-4k',
    group: 'custom',
    method: 'GET',
    label: 'GET /api/kuro/4k-stream/:id',
    template: '/api/kuro/4k-stream/aqz-KE-bpKQ',
    description:
      '独自API 1: 最高画質(4K/HDR/60fps)映像・音声・FFmpeg結合Mux URLを1リクエストで自動解決します。',
  },
  {
    id: 'kuro-batch',
    group: 'custom',
    method: 'POST',
    label: 'POST /api/kuro/batch-meta',
    template: '/api/kuro/batch-meta',
    defaultBody: DEFAULT_BATCH_BODY,
    description:
      '独自API 2: 最大20本の動画IDを受け取り、並列解決＋L1キャッシュで一括メタデータを返却します。',
  },
  {
    id: 'kuro-shield',
    group: 'custom',
    method: 'GET',
    label: 'GET /api/kuro/edge-shield',
    template: '/api/kuro/edge-shield',
    description:
      '独自API 3: リバースプロキシ防御状態、オリジン隔離(127.0.0.1:3001)、WAF統計・監査ログを取得します。',
  },
  {
    id: 'kuro-autofallback',
    group: 'custom',
    method: 'GET',
    label: 'GET /api/kuro/auto-fallback/:id',
    template: '/api/kuro/auto-fallback/aqz-KE-bpKQ?profile=auto&downlink=25',
    description:
      '追加API 1 (自動フォールバック): 環境に応じて7サーバー(高速→高画質→安定→Edu)を順次に自動検証し最善ストリームを返します。',
  },
  {
    id: 'kuro-cluster',
    group: 'custom',
    method: 'GET',
    label: 'GET /api/kuro/cluster-nodes',
    template: '/api/kuro/cluster-nodes',
    description:
      '追加API 2 (7サーバー監視): 安定型(3)・高速型(2)・高画質型(2)の全7サーバーの死活・応答速度を取得します。',
  },
  {
    id: 'kuro-stable',
    group: 'custom',
    method: 'GET',
    label: 'GET /api/kuro/stable-stream/:id',
    template: '/api/kuro/stable-stream/aqz-KE-bpKQ',
    description:
      '追加API 3 (安定型): 学校端末や低互換環境向けに H.264/AAC MP4 と Classroom/Kahoot Edu フォールバックを返します。',
  },
  {
    id: 'kuro-fast',
    group: 'custom',
    method: 'GET',
    label: 'GET /api/kuro/fast-stream/:id',
    template: '/api/kuro/fast-stream/aqz-KE-bpKQ',
    description:
      '追加API 4 (高速型): Googlevideo IP秘匿 Range MP4 と並列レースURLを最短レイテンシで返却します。',
  },
  {
    id: 'kuro-hq',
    group: 'custom',
    method: 'GET',
    label: 'GET /api/kuro/hq-stream/:id',
    template: '/api/kuro/hq-stream/aqz-KE-bpKQ',
    description:
      '追加API 5 (高画質型): 4K60/HDR + FFmpeg MP4結合 + Adaptive HLS (.m3u8) ストリームを返却します。',
  },
  {
    id: 'kuro-edu',
    group: 'custom',
    method: 'GET',
    label: 'GET /api/kuro/edu-embed/:id',
    template: '/api/kuro/edu-embed/aqz-KE-bpKQ',
    description:
      '追加API 6 (Edu再生): Google Classroom (youtubeeducation.com) & Kahoot! 用埋め込みURL・oEmbed検証を返却します。',
  },
  {
    id: 'kuro-googlevideo',
    group: 'custom',
    method: 'GET',
    label: 'GET /api/v1/stream/googlevideo/:id',
    template: '/api/v1/stream/googlevideo/aqz-KE-bpKQ?inspect=true&profile=fast',
    description:
      '追加API 7 (Googlevideo MP4): IP秘匿・UAローテーション済み HTTP 206 Range 中継 (inspect=true で検証情報返却)。',
  },
  {
    id: 'kuro-live-servers',
    group: 'custom',
    method: 'GET',
    label: 'GET /api/kuro/live-servers',
    template: '/api/kuro/live-servers',
    description:
      '追加API 8 (死活監視): 自前7サーバー・外部 Invidious・Zernio・Piped サーバーの生存/遅延/停止状態をリアルタイム判定します。',
  },
  {
    id: 'kuro-external-recover',
    group: 'custom',
    method: 'POST',
    label: 'POST /api/kuro/external-recover/:id',
    template: '/api/kuro/external-recover/aqz-KE-bpKQ',
    defaultBody: JSON.stringify({ customInvidiousUrl: '', customZernioUrl: '' }, null, 2),
    description:
      '追加API 9 (外部自動復旧): 生存中の外部 Invidious & Zernio/Piped サーバーを探索し、ストリームを自動復旧します。',
  },
  {
    id: 'kuro-translate',
    group: 'custom',
    method: 'POST',
    label: 'POST /api/v1/translate',
    template: '/api/v1/translate',
    defaultBody: JSON.stringify(
      {
        texts: ['Big Buck Bunny 60fps 4K Ultra HD Demo', 'High bitrate adaptive streaming'],
        targetLang: 'ja',
      },
      null,
      2,
    ),
    description:
      '追加API 10 (自動翻訳): 海外動画タイトル・概要欄・コメント・字幕を一括翻訳します。',
  },
  {
    id: 'video',
    group: 'standard',
    method: 'GET',
    label: 'GET /api/v1/videos/:id',
    template: '/api/v1/videos/aqz-KE-bpKQ',
    description: '動画メタデータ、maxresサムネイル、適応型ストリーム情報、関連動画を取得します。',
  },
  {
    id: 'search',
    group: 'standard',
    method: 'GET',
    label: 'GET /api/v1/search',
    template: '/api/v1/search?q=4k+japan+hdr&type=video&sort_by=relevance',
    description: 'リアルタイム InnerTube 検索結果を Invidious JSON 形式で返却します。',
  },
  {
    id: 'trending',
    group: 'standard',
    method: 'GET',
    label: 'GET /api/v1/trending',
    template: '/api/v1/trending?type=4K&region=JP',
    description: '4K HDR・音楽・ゲーム・テック別の急上昇フィードを取得します。',
  },
  {
    id: 'comments',
    group: 'standard',
    method: 'GET',
    label: 'GET /api/v1/comments/:id',
    template: '/api/v1/comments/aqz-KE-bpKQ',
    description: '投稿者アイコン・いいね数付きのコメントスレッドを取得します。',
  },
  {
    id: 'channel',
    group: 'standard',
    method: 'GET',
    label: 'GET /api/v1/channels/:id',
    template: '/api/v1/channels/UCSMOQeBJ2RAnuFungnQOxLg',
    description: 'チャンネルのバナー、アイコン、登録者数、最新動画一覧を取得します。',
  },
  {
    id: 'stats',
    group: 'standard',
    method: 'GET',
    label: 'GET /api/v1/stats',
    template: '/api/v1/stats',
    description: 'L1エッジキャッシュのヒット率、平均レイテンシ、稼働統計を返却します。',
  },
  {
    id: 'instances',
    group: 'standard',
    method: 'GET',
    label: 'GET /api/v1/instances',
    template: '/api/v1/instances',
    description: '自前保護オリジンおよび公開 Invidious ノードの死活監視と実測応答速度を取得します。',
  },
];

export function ApiConsoleView({ initialEndpoint }: ApiConsoleViewProps) {
  const initialPreset =
    (initialEndpoint && PRESETS.find((p) => initialEndpoint.startsWith(p.template.split('?')[0]))) ||
    PRESETS[0];

  const [method, setMethod] = useState<'GET' | 'POST'>(initialPreset.method);
  const [endpoint, setEndpoint] = useState(initialEndpoint || PRESETS[0].template);
  const [requestBody, setRequestBody] = useState(initialPreset.defaultBody || DEFAULT_BATCH_BODY);
  const [loading, setLoading] = useState(false);
  const [benchmarking, setBenchmarking] = useState(false);
  const [outputTab, setOutputTab] = useState<'json' | 'curl' | 'fetch'>('json');
  const [copied, setCopied] = useState(false);

  const [result, setResult] = useState<{
    status: number;
    latencyMs: number;
    cacheStatus: string;
    upstreamNode: string;
    payloadBytes: number;
    jsonText: string;
  } | null>(null);

  const [benchResult, setBenchResult] = useState<{
    coldMs: number;
    warmMs: number;
    speedup: string;
  } | null>(null);

  const [error, setError] = useState<string | null>(null);

  const buildRequestInit = (targetMethod: 'GET' | 'POST', bodyText: string): RequestInit | undefined => {
    if (targetMethod === 'POST') {
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyText,
      };
    }
    return undefined;
  };

  const runRequest = async (
    targetPath = endpoint,
    targetMethod: 'GET' | 'POST' = method,
    targetBody = requestBody,
  ) => {
    setLoading(true);
    setError(null);
    try {
      if (targetMethod === 'POST') {
        try {
          JSON.parse(targetBody);
        } catch {
          throw new Error('リクエスト JSON の構文が正しくありません。');
        }
      }
      const res = await probeApi<unknown>(targetPath, buildRequestInit(targetMethod, targetBody));
      setResult({
        status: res.status,
        latencyMs: res.latencyMs,
        cacheStatus: res.cacheStatus,
        upstreamNode: res.upstreamNode,
        payloadBytes: res.payloadBytes,
        jsonText: JSON.stringify(res.data, null, 2),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'リクエストに失敗しました');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialEndpoint) {
      const matched = PRESETS.find((p) =>
        initialEndpoint.startsWith(p.template.split('?')[0].replace(':id', '')),
      );
      const nextMethod = matched?.method || 'GET';
      const nextBody = matched?.defaultBody || requestBody;
      setMethod(nextMethod);
      setEndpoint(initialEndpoint);
      if (matched?.defaultBody) setRequestBody(matched.defaultBody);
      runRequest(initialEndpoint, nextMethod, nextBody);
    } else {
      runRequest(PRESETS[0].template, PRESETS[0].method, requestBody);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEndpoint]);

  const runBenchmark = async () => {
    setBenchmarking(true);
    setError(null);
    setBenchResult(null);
    try {
      if (method === 'POST') {
        const init = buildRequestInit('POST', requestBody);
        const first = await probeApi<unknown>(endpoint, init);
        const second = await probeApi<unknown>(endpoint, init);
        const ratio = second.latencyMs > 0 ? Math.max(1, Math.round(first.latencyMs / second.latencyMs)) : 1;
        setBenchResult({
          coldMs: first.latencyMs,
          warmMs: second.latencyMs,
          speedup: `キャッシュウォーム後 ${ratio}倍 高速化`,
        });
        setResult({
          status: second.status,
          latencyMs: second.latencyMs,
          cacheStatus: second.cacheStatus,
          upstreamNode: second.upstreamNode,
          payloadBytes: second.payloadBytes,
          jsonText: JSON.stringify(second.data, null, 2),
        });
      } else {
        const separator = endpoint.includes('?') ? '&' : '?';
        const coldUrl = `${endpoint}${separator}refresh=true`;
        const cold = await probeApi<unknown>(coldUrl);
        const warm = await probeApi<unknown>(endpoint);
        const ratio = warm.latencyMs > 0 ? Math.max(1, Math.round(cold.latencyMs / warm.latencyMs)) : 1;
        setBenchResult({
          coldMs: cold.latencyMs,
          warmMs: warm.latencyMs,
          speedup: `L1キャッシュで ${ratio}倍 高速化`,
        });
        setResult({
          status: warm.status,
          latencyMs: warm.latencyMs,
          cacheStatus: warm.cacheStatus,
          upstreamNode: warm.upstreamNode,
          payloadBytes: warm.payloadBytes,
          jsonText: JSON.stringify(warm.data, null, 2),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ベンチマークに失敗しました');
    } finally {
      setBenchmarking(false);
    }
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const fullUrl = `${origin}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  const compactBody = (() => {
    try {
      return JSON.stringify(JSON.parse(requestBody));
    } catch {
      return requestBody;
    }
  })();

  const curlSnippet =
    method === 'POST'
      ? `curl -i -X POST "${fullUrl}" \\\n  -H "Content-Type: application/json" \\\n  -d '${compactBody}'`
      : `curl -i "${fullUrl}"`;

  const fetchSnippet =
    method === 'POST'
      ? `const res = await fetch("${fullUrl}", {\n  method: "POST",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify(${requestBody}),\n});\nconst data = await res.json();\nconsole.log(res.headers.get("X-Proxy-Shield"), res.headers.get("X-Response-Time"), data);`
      : `const res = await fetch("${fullUrl}");\nconst data = await res.json();\nconsole.log(res.headers.get("X-Proxy-Shield"), res.headers.get("X-Cache"), res.headers.get("X-Response-Time"), data);`;

  const displayedCode =
    outputTab === 'json'
      ? result?.jsonText || 'リクエストを実行すると JSON レスポンスが表示されます。'
      : outputTab === 'curl'
        ? curlSnippet
        : fetchSnippet;

  const handleCopy = () => {
    navigator.clipboard.writeText(displayedCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const customPresets = PRESETS.filter((p) => p.group === 'custom');
  const standardPresets = PRESETS.filter((p) => p.group === 'standard');

  const renderPresetButton = (preset: EndpointPreset) => {
    const basePath = preset.template.split('?')[0].replace(':id', '');
    const active = endpoint.startsWith(basePath) && method === preset.method;
    return (
      <button
        key={preset.id}
        type="button"
        onClick={() => {
          const nextBody = preset.defaultBody || requestBody;
          setMethod(preset.method);
          setEndpoint(preset.template);
          if (preset.defaultBody) setRequestBody(preset.defaultBody);
          setBenchResult(null);
          runRequest(preset.template, preset.method, nextBody);
        }}
        className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors ${
          active
            ? 'border-blue-600/40 bg-blue-50/60 dark:bg-blue-950/20'
            : 'border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
        }`}
      >
        <span className="font-mono text-xs font-semibold text-zinc-900 dark:text-zinc-100">
          {preset.label}
        </span>
        <span className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          {preset.description}
        </span>
      </button>
    );
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      <aside className="lg:col-span-4 flex flex-col gap-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
        <div className="flex flex-col gap-1.5">
          <div className="pb-2 border-b border-zinc-100 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              KuroStream 独自拡張・7サーバー API (全13種)
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              プロキシ保護と4K高速配信に特化した独自エンドポイントです。
            </p>
          </div>
          <div className="flex flex-col gap-1 pt-1">
            {customPresets.map(renderPresetButton)}
          </div>
        </div>

        <div className="flex flex-col gap-1.5 pt-2 border-t border-zinc-100 dark:border-zinc-800">
          <div className="pb-1.5">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Invidious v1 標準 API
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              CORS・Gzip圧縮対応の標準互換 REST API です。
            </p>
          </div>
          <div className="flex flex-col gap-1">
            {standardPresets.map(renderPresetButton)}
          </div>
        </div>
      </aside>

      <div className="lg:col-span-8 flex flex-col gap-4">
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runRequest(endpoint, method, requestBody);
            }}
            className="flex flex-col sm:flex-row gap-2.5"
          >
            <div className="flex flex-1 items-center rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
              <select
                aria-label="HTTP メソッド"
                value={method}
                onChange={(e) => setMethod(e.target.value as 'GET' | 'POST')}
                className={`h-9 border-r border-zinc-200 dark:border-zinc-800 bg-transparent px-3 font-mono text-xs font-semibold focus:outline-none shrink-0 ${
                  method === 'POST'
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-emerald-600 dark:text-emerald-400'
                }`}
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </select>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                className="h-9 w-full bg-transparent px-3 font-mono text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="submit"
                disabled={loading || benchmarking}
                className="flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Play className="h-3.5 w-3.5" />
                <span>{loading ? '実行中...' : '送信'}</span>
              </button>

              <button
                type="button"
                disabled={loading || benchmarking}
                onClick={runBenchmark}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-3.5 text-xs font-semibold text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Zap className="h-3.5 w-3.5 text-amber-500" />
                <span>{benchmarking ? '計測中...' : '速度ベンチマーク'}</span>
              </button>
            </div>
          </form>

          {method === 'POST' && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                <span>リクエストボディ (JSON)</span>
                <button
                  type="button"
                  onClick={() => setRequestBody(DEFAULT_BATCH_BODY)}
                  className="font-mono text-blue-600 dark:text-blue-400 hover:underline"
                >
                  サンプルを復元
                </button>
              </div>
              <textarea
                rows={4}
                value={requestBody}
                onChange={(e) => setRequestBody(e.target.value)}
                spellCheck={false}
                className="kuro-scroll w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-900 dark:text-zinc-100 focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}

          {benchResult && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/20 px-3.5 py-2.5 font-mono text-xs tabular-nums">
              <div className="flex items-center gap-3 text-zinc-700 dark:text-zinc-300">
                <span>初回取得 (MISS): <strong>{benchResult.coldMs.toFixed(2)} ms</strong></span>
                <span aria-hidden="true">→</span>
                <span>キャッシュ (HIT): <strong className="text-emerald-600 dark:text-emerald-400">{benchResult.warmMs.toFixed(2)} ms</strong></span>
              </div>
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                {benchResult.speedup}
              </span>
            </div>
          )}

          {result && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 font-mono text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                HTTP {result.status} OK
              </span>
              <span aria-hidden="true">·</span>
              <span>応答時間: <strong className="text-zinc-800 dark:text-zinc-200">{result.latencyMs.toFixed(2)} ms</strong></span>
              <span aria-hidden="true">·</span>
              <span>キャッシュ: <strong className="text-zinc-800 dark:text-zinc-200">{result.cacheStatus}</strong></span>
              <span aria-hidden="true">·</span>
              <span>ノード: {result.upstreamNode}</span>
              <span aria-hidden="true">·</span>
              <span>サイズ: {formatBytes(result.payloadBytes)}</span>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/20 p-4 text-xs font-mono text-red-700 dark:text-red-400">
            {error}
          </div>
        )}

        <div className="flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
          <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-4 py-2.5">
            <div className="flex items-center gap-1 rounded-lg bg-zinc-100 dark:bg-zinc-950 p-1">
              {(['json', 'curl', 'fetch'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setOutputTab(tab)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    outputTab === tab
                      ? 'bg-white dark:bg-zinc-800 text-zinc-950 dark:text-white shadow-xs'
                      : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }`}
                >
                  {tab === 'json' ? 'レスポンス JSON' : tab === 'curl' ? 'cURL コマンド' : 'TypeScript Fetch'}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copied ? 'コピー完了' : 'コピー'}</span>
            </button>
          </div>

          <pre className="kuro-scroll max-h-[540px] overflow-auto bg-zinc-50 dark:bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-800 dark:text-zinc-200">
            <code>{displayedCode}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
