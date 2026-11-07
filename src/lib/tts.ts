/**
 * 浏览器语音合成（Phase B）—— 见 docs/phase-b-contract.md §6。
 *
 * 只用浏览器内置 SpeechSynthesis，零依赖、零成本；云端 TTS 留待以后。
 * 所有函数在无 speechSynthesis 或非浏览器环境下安全降级（空数组 / false / 空操作）。
 *
 * 说明：本文件由两个并行会话同时产出过（Lead 指派的 feedback-engine 与另一会话），
 * 现合并为一份契约一致的实现：
 * - 保留另一会话的 `isSpeechSupported` 判定、Safari 手势提示与 300ms 二次同步；
 * - 按契约把 `speak` 的 rate 缺省值定为 1；
 * - `pickEnglishVoice` 优先 en-US → en-GB → 列表首个。
 */

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
    // 契约：rate 缺省 1（1 ≈ 正常语速）。
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
    // 某些浏览器首帧拿不到语音列表，补一次短延时再同步。
    const timer = window.setTimeout(sync, 300);
    return () => {
      window.speechSynthesis.removeEventListener?.('voiceschanged', sync);
      window.clearTimeout(timer);
    };
  }, []);

  return voices;
}
