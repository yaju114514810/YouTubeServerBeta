import { useEffect, useState } from 'react';
import { Languages, RefreshCw, ShieldCheck, X } from 'lucide-react';
import {
  DEFAULT_APP_SETTINGS,
  TRANSLATION_LANG_OPTIONS,
  useAppSettings,
} from '../lib/appSettings';
import type { TargetTranslationLang } from '../types/invidious';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [settings, updateSettings] = useAppSettings();
  const [customInv, setCustomInv] = useState(settings.customInvidiousUrl);
  const [customZernio, setCustomZernio] = useState(settings.customZernioUrl);
  const [savedNote, setSavedNote] = useState(false);

  useEffect(() => {
    setCustomInv(settings.customInvidiousUrl);
    setCustomZernio(settings.customZernioUrl);
  }, [settings.customInvidiousUrl, settings.customZernioUrl, open]);

  if (!open) return null;

  const handleSaveUrls = (e: React.FormEvent) => {
    e.preventDefault();
    updateSettings({
      customInvidiousUrl: customInv,
      customZernioUrl: customZernio,
    });
    setSavedNote(true);
    window.setTimeout(() => setSavedNote(false), 1800);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="KuroStream アプリ設定"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-5 py-4">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-base font-bold text-zinc-950 dark:text-white">
              自動翻訳・外部サーバー自動復旧設定
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              設定はブラウザに自動保存され、探索・プレイヤー・死活監視へ即時反映されます。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="設定を閉じる"
            className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="kuro-scroll flex flex-col gap-6 overflow-y-auto p-5">
          {/* セクション1: 海外動画 自動翻訳設定 */}
          <section className="flex flex-col gap-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Languages className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
                <div>
                  <h3 className="text-sm font-semibold text-zinc-950 dark:text-white">
                    海外動画の自動翻訳
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    外国語のタイトル・概要欄・コメント・字幕トラックを指定言語へ自動翻訳します。
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => updateSettings({ autoTranslateEnabled: !settings.autoTranslateEnabled })}
                className={`h-8 rounded-lg px-3 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  settings.autoTranslateEnabled
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300'
                }`}
              >
                {settings.autoTranslateEnabled ? '自動翻訳: ON' : '自動翻訳: OFF'}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-zinc-200/70 dark:border-zinc-800">
              <label className="flex flex-col gap-1.5 text-xs">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">翻訳先の言語</span>
                <select
                  value={settings.targetLang}
                  onChange={(e) =>
                    updateSettings({ targetLang: e.target.value as TargetTranslationLang })
                  }
                  className="h-9 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 text-xs font-medium text-zinc-900 dark:text-zinc-100 focus:border-blue-600 focus:outline-none"
                >
                  {TRANSLATION_LANG_OPTIONS.map((opt) => (
                    <option key={opt.code} value={opt.code}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex flex-col justify-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.translateTitles}
                    onChange={(e) => updateSettings({ translateTitles: e.target.checked })}
                    className="h-4 w-4 accent-blue-600"
                  />
                  <span>動画タイトル・関連動画を翻訳</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.translateDescriptions}
                    onChange={(e) => updateSettings({ translateDescriptions: e.target.checked })}
                    className="h-4 w-4 accent-blue-600"
                  />
                  <span>動画の概要欄を翻訳</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.translateComments}
                    onChange={(e) => updateSettings({ translateComments: e.target.checked })}
                    className="h-4 w-4 accent-blue-600"
                  />
                  <span>コメント欄を翻訳</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.translateCaptions}
                    onChange={(e) => updateSettings({ translateCaptions: e.target.checked })}
                    className="h-4 w-4 accent-blue-600"
                  />
                  <span>字幕トラック (WebVTT / Edu字幕) を翻訳</span>
                </label>
              </div>
            </div>
          </section>

          {/* セクション2: 再生エラー自動復旧化 (外部 Invidious + Zernio 生存サーバー探索) */}
          <section className="flex flex-col gap-3.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <RefreshCw className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div>
                  <h3 className="text-sm font-semibold text-zinc-950 dark:text-white">
                    再生エラー自動復旧 (外部 Invidious &amp; Zernio 生存探索)
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    全エンジンで再生できなかった場合、生きている外部 Invidious / Zernio サーバーを自動検索して再生を復旧します。
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => updateSettings({ autoExternalRecovery: !settings.autoExternalRecovery })}
                className={`h-8 rounded-lg px-3 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  settings.autoExternalRecovery
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300'
                }`}
              >
                {settings.autoExternalRecovery ? '自動復旧: ON' : '自動復旧: OFF'}
              </button>
            </div>

            <form
              onSubmit={handleSaveUrls}
              className="flex flex-col gap-3 pt-2 border-t border-zinc-200/70 dark:border-zinc-800"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    優先外部 Invidious URL（任意）
                  </span>
                  <input
                    type="text"
                    value={customInv}
                    onChange={(e) => setCustomInv(e.target.value)}
                    placeholder="例: https://inv.nadeko.net"
                    className="h-9 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 font-mono text-xs text-zinc-900 dark:text-zinc-100 focus:border-blue-600 focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    優先外部 Zernio サーバー URL（任意）
                  </span>
                  <input
                    type="text"
                    value={customZernio}
                    onChange={(e) => setCustomZernio(e.target.value)}
                    placeholder="例: https://your-zernio-node.example"
                    className="h-9 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 font-mono text-xs text-zinc-900 dark:text-zinc-100 focus:border-blue-600 focus:outline-none"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => {
                    updateSettings(DEFAULT_APP_SETTINGS);
                    setCustomInv('');
                    setCustomZernio('');
                  }}
                  className="text-xs font-medium text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 underline"
                >
                  初期設定に戻す
                </button>

                <div className="flex items-center gap-3">
                  {savedNote && (
                    <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      外部サーバーURLを保存しました
                    </span>
                  )}
                  <button
                    type="submit"
                    className="rounded-lg bg-zinc-900 dark:bg-white px-4 py-1.5 text-xs font-semibold text-white dark:text-zinc-950 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
                  >
                    外部ノードURLを適用
                  </button>
                </div>
              </div>
            </form>
          </section>

          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>
              Edu再生は正規 <code className="font-mono">youtubeeducation.com</code> を使用し、直接ストリーム復旧後の最終保証としても動作します。
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
