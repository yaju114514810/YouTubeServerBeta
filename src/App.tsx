import { useEffect, useState } from 'react';
import { Check, Copy, Languages, Moon, SlidersHorizontal, Sun } from 'lucide-react';
import { ExplorerView } from './components/ExplorerView';
import { PlayerView } from './components/PlayerView';
import { ChannelView } from './components/ChannelView';
import { ApiConsoleView } from './components/ApiConsoleView';
import { NodesView } from './components/NodesView';
import { SettingsModal } from './components/SettingsModal';
import { useAppSettings } from './lib/appSettings';

type ActiveTab = 'explorer' | 'player' | 'channel' | 'console' | 'nodes';

export default function App() {
  const [dark, setDark] = useState(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('explorer');
  const [selectedVideoId, setSelectedVideoId] = useState('aqz-KE-bpKQ');
  const [selectedChannelId, setSelectedChannelId] = useState('UCSMOQeBJ2RAnuFungnQOxLg');
  const [consoleEndpoint, setConsoleEndpoint] = useState<string | undefined>(undefined);
  const [copiedBaseUrl, setCopiedBaseUrl] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings] = useAppSettings();

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [dark]);

  const handleSelectVideo = (videoId: string) => {
    setSelectedVideoId(videoId);
    setActiveTab('player');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSelectChannel = (channelId: string) => {
    setSelectedChannelId(channelId);
    setActiveTab('channel');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleInspectInApi = (endpoint: string) => {
    setConsoleEndpoint(endpoint);
    setActiveTab('console');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCopyBaseUrl = () => {
    const url = `${window.location.origin}/api/v1`;
    navigator.clipboard.writeText(url);
    setCopiedBaseUrl(true);
    window.setTimeout(() => setCopiedBaseUrl(false), 1800);
  };

  const navItems: { id: ActiveTab; label: string }[] = [
    { id: 'explorer', label: '探索' },
    { id: 'player', label: 'ストリーム再生' },
    { id: 'console', label: 'APIコンソール' },
    { id: 'nodes', label: 'ノード状況' },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 transition-colors duration-150">
      {/* トップバー: 3ゾーン構成 */}
      <header className="sticky top-0 z-40 border-b border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-8 px-4 sm:px-6">
          {/* ゾーン1: ブランドワードマーク */}
          <button
            type="button"
            onClick={() => setActiveTab('explorer')}
            className="font-display text-lg font-bold tracking-tight text-zinc-950 dark:text-white whitespace-nowrap shrink-0"
          >
            KuroStream
          </button>

          {/* ゾーン2: ナビゲーション */}
          <nav aria-label="メインナビゲーション" className="flex items-center gap-6 overflow-x-auto">
            {navItems.map((item) => {
              const isCurrent =
                activeTab === item.id || (activeTab === 'channel' && item.id === 'explorer');
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`relative py-4 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                    isCurrent
                      ? 'text-zinc-950 dark:text-white'
                      : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                  }`}
                >
                  {item.label}
                  {isCurrent && (
                    <span className="absolute inset-x-0 bottom-0 h-0.5 bg-blue-600 dark:bg-blue-500" />
                  )}
                </button>
              );
            })}
          </nav>

          {/* ゾーン3: プライマリアクション */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                settings.autoTranslateEnabled
                  ? 'border-blue-500/40 bg-blue-50/70 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 hover:bg-blue-100/80 dark:hover:bg-blue-950/50'
                  : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              {settings.autoTranslateEnabled ? (
                <Languages className="h-3.5 w-3.5" />
              ) : (
                <SlidersHorizontal className="h-3.5 w-3.5" />
              )}
              <span>
                設定 {settings.autoTranslateEnabled ? `(翻訳:${settings.targetLang.toUpperCase()})` : ''}
              </span>
            </button>

            <button
              type="button"
              onClick={handleCopyBaseUrl}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-900 dark:bg-white px-3.5 py-2 text-xs font-semibold text-white dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors whitespace-nowrap shrink-0"
            >
              {copiedBaseUrl ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400 dark:text-emerald-600" />
                  <span>コピー完了</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>API URLコピー</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* メインコンテンツ */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 sm:px-6 py-6 flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-zinc-950 dark:text-white">
              {activeTab === 'explorer' && '超高速 4K Invidious エクスプローラー'}
              {activeTab === 'player' && '超安定・環境最適化 MP4 / Googlevideo / Edu再生'}
              {activeTab === 'channel' && 'チャンネル動画一覧'}
              {activeTab === 'console' && '7サーバー拡張 API・Invidious v1 コンソール'}
              {activeTab === 'nodes' && '7サーバー自動フォールバック・プロキシ防御監視'}
            </h1>
            <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400">
              リバースプロキシで隔離保護された自前オリジン（
              <code className="rounded bg-zinc-200/70 dark:bg-zinc-800/80 px-1.5 py-0.5 text-xs font-mono text-zinc-800 dark:text-zinc-200">
                127.0.0.1:3001
              </code>
              ）と{' '}
              <code className="rounded bg-zinc-200/70 dark:bg-zinc-800/80 px-1.5 py-0.5 text-xs font-mono text-zinc-800 dark:text-zinc-200">
                /api/kuro/*
              </code>{' '}
              ・{' '}
              <code className="rounded bg-zinc-200/70 dark:bg-zinc-800/80 px-1.5 py-0.5 text-xs font-mono text-zinc-800 dark:text-zinc-200">
                /api/v1/*
              </code>{' '}
              高速ゲートウェイ
            </p>
          </div>

          <button
            type="button"
            onClick={() => setDark((d) => !d)}
            aria-label={dark ? 'ライトモードへ切替' : 'ダークモードへ切替'}
            className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
          >
            {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            <span>{dark ? 'ライトモード' : 'ダークモード'}</span>
          </button>
        </div>

        {activeTab === 'explorer' && (
          <ExplorerView
            onSelectVideo={handleSelectVideo}
            onSelectChannel={handleSelectChannel}
          />
        )}

        {activeTab === 'player' && (
          <PlayerView
            videoId={selectedVideoId}
            onSelectVideo={handleSelectVideo}
            onSelectChannel={handleSelectChannel}
            onInspectInApi={handleInspectInApi}
            onBackToExplorer={() => setActiveTab('explorer')}
          />
        )}

        {activeTab === 'channel' && (
          <ChannelView
            channelId={selectedChannelId}
            onSelectVideo={handleSelectVideo}
            onSelectChannel={handleSelectChannel}
            onInspectInApi={handleInspectInApi}
            onBack={() => setActiveTab('explorer')}
          />
        )}

        {activeTab === 'console' && (
          <ApiConsoleView initialEndpoint={consoleEndpoint} />
        )}

        {activeTab === 'nodes' && <NodesView />}
      </main>

      <footer className="border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-4 sm:px-6 py-4 text-xs text-zinc-500 dark:text-zinc-400">
          <span>KuroStream 自前構築 Invidious サーバー &amp; プロキシ防御ゲートウェイ</span>
          <div className="flex flex-wrap items-center gap-4 font-mono">
            <button
              type="button"
              onClick={() => handleInspectInApi('/api/kuro/4k-stream/aqz-KE-bpKQ')}
              className="hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
            >
              /api/kuro/4k-stream
            </button>
            <button
              type="button"
              onClick={() => handleInspectInApi('/api/kuro/batch-meta')}
              className="hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
            >
              /api/kuro/batch-meta
            </button>
            <button
              type="button"
              onClick={() => handleInspectInApi('/api/kuro/edge-shield')}
              className="hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
            >
              /api/kuro/edge-shield
            </button>
            <button
              type="button"
              onClick={() => handleInspectInApi('/api/v1/stats')}
              className="hover:text-zinc-900 dark:hover:text-zinc-200 transition-colors"
            >
              /api/v1/stats
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
