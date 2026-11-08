import { useEffect, useState } from 'react';

export interface TtsVoice {
  voiceUri: string;
  name: string;
  lang: string;
}

/** 浏览器是否支持语音合成。 */
export function isSpeechSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance === 'function'
  );
}

/** 列出英文语音（lang 以 en 开头）；无支持时返回空数组。 */
export function listEnglishVoices(): TtsVoice[] {
  if (!isSpeechSupported()) return [];
  let voices: SpeechSynthesisVoice[] = [];
  try {
    voices = window.speechSynthesis.getVoices() ?? [];
  } catch {
    return [];
  }
  if (!Array.isArray(voices)) return [];
  return voices
    .filter((voice) => typeof voice?.lang === 'string' && voice.lang.trim().toLowerCase().startsWith('en'))
    .map((voice) => ({ voiceUri: voice.voiceURI, name: voice.name, lang: voice.lang }));
}

/** 是否有可用英文语音。 */
export function hasEnglishVoice(): boolean {
  return listEnglishVoices().length > 0;
}

/**
 * 选一个英文语音：优先用指定 URI，其次 en-US，再次 en-GB，最后取列表首个。
 */
export function pickEnglishVoice(preferredUri?: string): TtsVoice | null {
  const voices = listEnglishVoices();
  if (voices.length === 0) return null;
  if (preferredUri) {
    const matched = voices.find((voice) => voice.voiceUri === preferredUri);
    if (matched) return matched;
  }
  const normalize = (lang: string): string => lang.trim().toLowerCase().replace(/_/g, '-');
  const byLang = (tag: string): TtsVoice | undefined =>
    voices.find((voice) => normalize(voice.lang) === tag) ??
    voices.find((voice) => normalize(voice.lang).startsWith(tag));
  return byLang('en-us') ?? byLang('en-gb') ?? voices[0] ?? null;
}

/**
 * 朗读英文；返回是否成功发出。
 * 注意：Safari 首次播放需要用户手势，调用点应放在点击事件里。
 */
export function speak(
  text: string,
  options: { rate?: number; voiceUri?: string } = {},
): boolean {
  if (!isSpeechSupported() || !text.trim()) return false;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.trim());
    const voice = pickEnglishVoice(options.voiceUri);
    if (voice) {
      utterance.lang = voice.lang || 'en-US';
      const match = window.speechSynthesis
        .getVoices()
        .find((item) => item.voiceURI === voice.voiceUri);
      if (match) utterance.voice = match;
    } else {
      utterance.lang = 'en-US';
    }
    const rate = options.rate;
    utterance.rate =
      typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1;
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

/** 停止朗读。 */
export function cancelSpeech(): void {
  if (!isSpeechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* 忽略 */
  }
}

/** React Hook：返回可用英文语音列表，并监听 voiceschanged。 */
export function useEnglishVoices(): TtsVoice[] {
  const [voices, setVoices] = useState<TtsVoice[]>([]);

  useEffect(() => {
    if (!isSpeechSupported()) return;
    const sync = () => setVoices(listEnglishVoices());
    sync();
    window.speechSynthesis.addEventListener?.('voiceschanged', sync);
    const timer = window.setTimeout(sync, 300);
    return () => {
      window.speechSynthesis.removeEventListener?.('voiceschanged', sync);
      window.clearTimeout(timer);
    };
  }, []);

  return voices;
}
