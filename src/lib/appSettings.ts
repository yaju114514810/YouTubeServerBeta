import { useEffect, useState } from 'react';
import type { AppSettings, TargetTranslationLang } from '../types/invidious';

const STORAGE_KEY = 'kurostream_app_settings_v1';
const SETTINGS_EVENT = 'kurostream:settings-updated';

export const TRANSLATION_LANG_OPTIONS: { code: TargetTranslationLang; label: string }[] = [
  { code: 'ja', label: '日本語 (Japanese)' },
  { code: 'en', label: '英語 (English)' },
  { code: 'ko', label: '韓国語 (한국어)' },
  { code: 'zh-CN', label: '中国語・簡体 (中文)' },
  { code: 'es', label: 'スペイン語 (Español)' },
  { code: 'fr', label: 'フランス語 (Français)' },
];

export const DEFAULT_APP_SETTINGS: AppSettings = {
  autoTranslateEnabled: true,
  targetLang: 'ja',
  translateTitles: true,
  translateDescriptions: true,
  translateComments: true,
  translateCaptions: true,
  autoExternalRecovery: true,
  customInvidiousUrl: '',
  customZernioUrl: '',
};

export function loadAppSettings(): AppSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_APP_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APP_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_APP_SETTINGS,
      ...parsed,
      customInvidiousUrl: typeof parsed.customInvidiousUrl === 'string' ? parsed.customInvidiousUrl.trim() : '',
      customZernioUrl: typeof parsed.customZernioUrl === 'string' ? parsed.customZernioUrl.trim() : '',
    };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export function saveAppSettings(next: AppSettings): AppSettings {
  const normalized: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    ...next,
    customInvidiousUrl: (next.customInvidiousUrl || '').trim().replace(/\/+$/, ''),
    customZernioUrl: (next.customZernioUrl || '').trim().replace(/\/+$/, ''),
  };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
      window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: normalized }));
    } catch {
      // ignore storage quota errors
    }
  }
  return normalized;
}

export function useAppSettings(): [AppSettings, (patch: Partial<AppSettings>) => void] {
  const [settings, setSettings] = useState<AppSettings>(() => loadAppSettings());

  useEffect(() => {
    const onUpdate = (ev: Event) => {
      const detail = (ev as CustomEvent<AppSettings>).detail;
      if (detail) {
        setSettings(detail);
      } else {
        setSettings(loadAppSettings());
      }
    };
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === STORAGE_KEY) {
        setSettings(loadAppSettings());
      }
    };
    window.addEventListener(SETTINGS_EVENT, onUpdate);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SETTINGS_EVENT, onUpdate);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const updateSettings = (patch: Partial<AppSettings>) => {
    const next = saveAppSettings({ ...loadAppSettings(), ...patch });
    setSettings(next);
  };

  return [settings, updateSettings];
}
