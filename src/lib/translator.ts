import type { TargetTranslationLang, TranslateResponse } from '../types/invidious';

const clientTranslationCache = new Map<string, string>();

export function needsTranslation(text: string, targetLang: TargetTranslationLang): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed || trimmed.length < 2) return false;
  // Skip pure numbers, URLs, or symbols
  if (/^[\d\s.,:/\-_#@!?()[\]{}|+*=%$]+$/.test(trimmed)) return false;

  if (targetLang === 'ja') {
    // If string already has Japanese Hiragana or Katakana, it is already Japanese
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(trimmed)) return false;
    // Check if it contains Latin, Hangul, Cyrillic, Arabic, Thai, or CJK without Kana
    return /[A-Za-z\uAC00-\uD7AF\u0400-\u04FF\u0600-\u06FF\u0E00-\u0E7F\u4E00-\u9FFF]/.test(trimmed);
  }

  if (targetLang === 'en') {
    // Needs translation if it contains non-ASCII letters (Japanese, Korean, Chinese, Cyrillic, etc.)
    return /[^\x00-\x7F]/.test(trimmed);
  }

  if (targetLang === 'ko') {
    if (/[\uAC00-\uD7AF]/.test(trimmed) && !/[\u3040-\u30FF]/.test(trimmed)) return false;
    return true;
  }

  if (targetLang === 'zh-CN') {
    if (/[\u4E00-\u9FFF]/.test(trimmed) && !/[\u3040-\u30FF\uAC00-\uD7AF]/.test(trimmed) && !/[A-Za-z]{4,}/.test(trimmed)) {
      return false;
    }
    return true;
  }

  return true;
}

export async function translateTexts(
  texts: string[],
  targetLang: TargetTranslationLang,
): Promise<string[]> {
  if (!texts.length) return [];

  const results = [...texts];
  const pendingIndices: number[] = [];
  const pendingTexts: string[] = [];

  for (let i = 0; i < texts.length; i++) {
    const raw = texts[i] || '';
    const cacheKey = `${targetLang}:${raw}`;
    const cached = clientTranslationCache.get(cacheKey);
    if (cached !== undefined) {
      results[i] = cached;
      continue;
    }
    if (!needsTranslation(raw, targetLang)) {
      continue;
    }
    pendingIndices.push(i);
    pendingTexts.push(raw);
  }

  if (pendingTexts.length === 0) return results;

  try {
    // Batch up to 30 strings per call to keep latency sub-second
    const CHUNK_SIZE = 30;
    for (let offset = 0; offset < pendingTexts.length; offset += CHUNK_SIZE) {
      const sliceTexts = pendingTexts.slice(offset, offset + CHUNK_SIZE);
      const sliceIndices = pendingIndices.slice(offset, offset + CHUNK_SIZE);

      const res = await fetch('/api/v1/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: sliceTexts, targetLang }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as TranslateResponse;
      if (Array.isArray(data?.translations)) {
        data.translations.forEach((tr, idx) => {
          const origIdx = sliceIndices[idx];
          const origText = sliceTexts[idx];
          const translated = typeof tr === 'string' && tr.trim() ? tr : origText;
          results[origIdx] = translated;
          if (clientTranslationCache.size > 1500) {
            const firstKey = clientTranslationCache.keys().next().value;
            if (firstKey !== undefined) clientTranslationCache.delete(firstKey);
          }
          clientTranslationCache.set(`${targetLang}:${origText}`, translated);
        });
      }
    }
  } catch {
    // Non-fatal: fall back to original text if translation service is unavailable
  }

  return results;
}
