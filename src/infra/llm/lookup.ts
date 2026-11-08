/**
 * 学习中随点解析 / 选句翻译 / 搜索：短讲解 + 内存缓存。
 */

import type { LLMSettings, Question, Word } from '@/domain/types';
import { chatComplete } from './forward';
import type { ChatMessage } from './types';

export type LookupKind = 'word' | 'sentence' | 'search';

export interface LookupRequest {
  kind: LookupKind;
  text: string;
  /** 题目上下文（题干 / 目标词等），句子解析时带上。 */
  context?: string;
}

export interface LookupResult {
  text: string;
  /** 命中内存缓存。 */
  cached: boolean;
  /** 命中本地词库，未走 LLM。 */
  local?: boolean;
}

const LOOKUP_TIMEOUT_MS = 20_000;
const LOOKUP_MAX_TOKENS = 280;

/** 进程内缓存：同一次学习会话重复点同一词不再请求。 */
const cache = new Map<string, string>();

const WORD_SYSTEM = `你是一位简洁的英汉词汇助手。根据用户给出的词或短语，用中文给出简短解析。
硬性规则：
1. 纯文本中文，不要 JSON、不要 markdown 代码围栏、不要列表符号堆砌。
2. 先给核心释义（≤40 字），再给 1 句用法或辨析（≤60 字）；总字数 ≤120 字。
3. 若输入是中文，给出对应英文与简短说明。
4. 不要复述题干，不要说「作为 AI」。`;

const SENTENCE_SYSTEM = `你是一位英汉互译与句子解析助手。根据学员选中的句子与题目上下文，给出翻译与简短解析。
硬性规则：
1. 纯文本中文，不要 JSON、不要 markdown 代码围栏。
2. 第一行：译文（或「译文：…」）。
3. 随后 1～2 句：结合题目上下文说明关键词或结构；总字数 ≤160 字。
4. 不要复述整道题，不要说「作为 AI」。`;

const SEARCH_SYSTEM = `你是一位学习助手，回答学员在答题时的即时查询（单词、短语、短句翻译）。
硬性规则：
1. 纯文本中文，不要 JSON、不要 markdown 代码围栏。
2. 直接给答案：释义 / 译文 + 一句要点；总字数 ≤140 字。
3. 不要跑题，不要说「作为 AI」。`;

export function normalizeLookupText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function lookupCacheKey(kind: LookupKind, text: string, context = ''): string {
  return `${kind}|${normalizeLookupText(text).toLowerCase()}|${normalizeLookupText(context).toLowerCase()}`;
}

export function getCachedLookup(kind: LookupKind, text: string, context = ''): string | undefined {
  return cache.get(lookupCacheKey(kind, text, context));
}

export function setCachedLookup(
  kind: LookupKind,
  text: string,
  value: string,
  context = '',
): void {
  const key = lookupCacheKey(kind, text, context);
  if (!value.trim()) return;
  cache.set(key, value.trim());
}

/** 测试或清理时用。 */
export function clearLookupCache(): void {
  cache.clear();
}

export function buildQuestionLookupContext(question: Question, word?: Word): string {
  const lines = [`题干：${question.prompt}`, `技能：${question.skill}`];
  if (word) {
    lines.push(`目标词：${word.term}`, `释义：${word.meaning}`);
  }
  if (question.answer) lines.push(`参考答案：${question.answer}`);
  return lines.join('\n');
}

function localWordHit(text: string, words: Word[]): string | undefined {
  const needle = normalizeLookupText(text).toLowerCase();
  if (!needle) return undefined;
  const hit = words.find((word) => word.term.trim().toLowerCase() === needle);
  if (!hit) return undefined;
  const parts = [`${hit.term}${hit.phonetic ? ` ${hit.phonetic}` : ''}：${hit.meaning}`];
  if (hit.partOfSpeech) parts.push(`词性：${hit.partOfSpeech}`);
  if (hit.example) {
    const translation = hit.exampleTranslation ? `（${hit.exampleTranslation}）` : '';
    parts.push(`例句：${hit.example}${translation}`);
  }
  return parts.join('\n');
}

function buildMessages(request: LookupRequest): ChatMessage[] {
  const text = normalizeLookupText(request.text);
  if (request.kind === 'sentence') {
    const user = [
      '请翻译并简要解析下面选中的句子。',
      '',
      `【选中内容】${text}`,
      request.context ? `\n【题目上下文】\n${request.context}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return [
      { role: 'system', content: SENTENCE_SYSTEM },
      { role: 'user', content: user },
    ];
  }

  if (request.kind === 'search') {
    return [
      { role: 'system', content: SEARCH_SYSTEM },
      {
        role: 'user',
        content: [
          `查询：${text}`,
          request.context ? `\n题目上下文：\n${request.context}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];
  }

  return [
    { role: 'system', content: WORD_SYSTEM },
    {
      role: 'user',
      content: [
        `请解析：${text}`,
        request.context ? `\n题目上下文（可选参考）：\n${request.context}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

export interface RunLookupOptions {
  signal?: AbortSignal;
  /** 本地词库：单词查询优先命中。 */
  words?: Word[];
}

/**
 * 执行一次解析：本地词库 → 缓存 → LLM。
 * 成功结果写入内存缓存。
 */
export async function runLookup(
  settings: LLMSettings,
  request: LookupRequest,
  options: RunLookupOptions = {},
): Promise<LookupResult> {
  const text = normalizeLookupText(request.text);
  if (!text) {
    return { text: '请先输入或选中内容。', cached: false };
  }

  const context = request.context ?? '';

  if (request.kind === 'word' || request.kind === 'search') {
    const local = localWordHit(text, options.words ?? []);
    if (local) {
      setCachedLookup(request.kind, text, local, context);
      return { text: local, cached: false, local: true };
    }
  }

  const cached = getCachedLookup(request.kind, text, context);
  if (cached) return { text: cached, cached: true };

  const raw = await chatComplete(settings, buildMessages(request), {
    signal: options.signal,
    timeoutMs: LOOKUP_TIMEOUT_MS,
    maxTokens: LOOKUP_MAX_TOKENS,
    temperature: 0.3,
    noThink: true,
  });

  const cleaned = raw
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const finalText = cleaned || '暂时没有解析结果，请稍后再试。';
  setCachedLookup(request.kind, text, finalText, context);
  return { text: finalText, cached: false };
}
