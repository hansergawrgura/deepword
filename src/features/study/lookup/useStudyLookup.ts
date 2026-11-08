/**
 * 学习页即时解析：点词 / 选句 / 搜索共用状态与请求。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LLMSettings, Question, Word } from '@/domain/types';
import {
  buildQuestionLookupContext,
  LLMError,
  normalizeLookupText,
  runLookup,
  type LookupKind,
} from '@/infra/llm';

export interface LookupAnchor {
  /** 相对视口的定位（用于气泡 / 选区图标）。 */
  top: number;
  left: number;
}

export interface StudyLookupState {
  kind: LookupKind;
  query: string;
  status: 'loading' | 'ready' | 'error';
  text: string;
  cached: boolean;
  local?: boolean;
  anchor: LookupAnchor | null;
}

export interface UseStudyLookupArgs {
  llmSettings: LLMSettings | null;
  aiAvailable: boolean;
  words: Word[];
  question?: Question;
  word?: Word;
}

export function useStudyLookup({
  llmSettings,
  aiAvailable,
  words,
  question,
  word,
}: UseStudyLookupArgs) {
  const [active, setActive] = useState<StudyLookupState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const context = useMemo(
    () => (question ? buildQuestionLookupContext(question, word) : ''),
    [question, word],
  );

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setActive(null);
  }, []);

  // 换题时收起气泡，避免上一题解析残留。
  useEffect(() => {
    clear();
  }, [question?.id, clear]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const lookup = useCallback(
    async (kind: LookupKind, raw: string, anchor: LookupAnchor | null = null) => {
      const query = normalizeLookupText(raw);
      if (!query) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setActive({
        kind,
        query,
        status: 'loading',
        text: '',
        cached: false,
        anchor,
      });

      if (!aiAvailable || !llmSettings) {
        // 无 AI 时仍尝试本地词库（runLookup 在无 settings 前我们自己查）。
        const local = words.find((item) => item.term.trim().toLowerCase() === query.toLowerCase());
        if (local) {
          const text = `${local.term}${local.phonetic ? ` ${local.phonetic}` : ''}：${local.meaning}`;
          setActive({
            kind,
            query,
            status: 'ready',
            text,
            cached: false,
            local: true,
            anchor,
          });
          return;
        }
        setActive({
          kind,
          query,
          status: 'error',
          text: '未配置可用 AI，无法在线解析。可先在设置里接入模型。',
          cached: false,
          anchor,
        });
        return;
      }

      try {
        const result = await runLookup(
          llmSettings,
          { kind, text: query, context },
          { signal: controller.signal, words },
        );
        if (controller.signal.aborted) return;
        setActive({
          kind,
          query,
          status: 'ready',
          text: result.text,
          cached: result.cached,
          local: result.local,
          anchor,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const message =
          error instanceof LLMError
            ? error.message
            : error instanceof Error
              ? error.message
              : '解析失败，请稍后再试。';
        setActive({
          kind,
          query,
          status: 'error',
          text: message,
          cached: false,
          anchor,
        });
      }
    },
    [aiAvailable, context, llmSettings, words],
  );

  return {
    active,
    context,
    lookup,
    clear,
    canLookupOnline: aiAvailable && Boolean(llmSettings),
  };
}

export type StudyLookupApi = ReturnType<typeof useStudyLookup>;
