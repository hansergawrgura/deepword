/**
 * 生成编排 + 严格校验。
 *
 * 模型输出一律视为不可信：先做 JSON 提取容错，再逐题校验（wordId / 题型 / 选项 / 答案 /
 * 长度 / 难度），能修正的答案修正、打乱选项，最后去重、限制每词题量与总题量。
 * 没有任何可用题目时抛带 code 的 LLMError，由 UI 提示或回退本地题库。
 */

import type { Exercise, ExerciseType } from '../../types';
import type { ExerciseRequest } from './types';
import { LLMError } from './types';
import { buildMessages } from './prompts';
import { chatComplete, hasUsableLLMConfig } from './providers';
import { clamp, normalizeAnswer, shuffle, uid } from '../utils';

const VALID_TYPES: ExerciseType[] = ['choice', 'fill', 'usage', 'correction'];
/** 每个词最多出 2 道题（与提示词约定一致，这里再兜底一次）。 */
const MAX_PER_TARGET = 2;
const MAX_PROMPT_LENGTH = 500;
const MAX_EXPLANATION_LENGTH = 400;
const MAX_FILL_ACCEPTABLE_ANSWERS = 10;
/** fill 题干必须包含连续下划线（半角或全角）。 */
const BLANK_PATTERN = /_{2,}|＿{2,}/;

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function clampText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function isExerciseType(value: unknown): value is ExerciseType {
  return typeof value === 'string' && (VALID_TYPES as string[]).includes(value);
}

function truncateSnippet(text: string, maxLength = 180): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength)}…` : collapsed;
}

/* ------------------------------------------------------------------ */
/* JSON 提取容错                                                       */
/* ------------------------------------------------------------------ */

/**
 * 从模型原始输出中提取 JSON 文本：
 * - 去掉 ```json / ``` 代码围栏；
 * - 截取第一个 `{` 到最后一个 `}`（兼容前后夹杂解释文字）；
 * - 根节点是数组时截取 `[` 到 `]`（以最先出现的结构为准）。
 */
export function extractJsonCandidate(raw: string): string | null {
  if (!raw) return null;

  let text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1].trim()) text = fenced[1].trim();

  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  const hasObject = objectStart !== -1 && objectEnd > objectStart;
  const hasArray = arrayStart !== -1 && arrayEnd > arrayStart;

  // 以最先出现的结构为准：根是数组时不会被内部的 { } 截断，反之亦然。
  if (hasObject && hasArray) {
    return arrayStart < objectStart
      ? text.slice(arrayStart, arrayEnd + 1)
      : text.slice(objectStart, objectEnd + 1);
  }
  if (hasObject) return text.slice(objectStart, objectEnd + 1);
  if (hasArray) return text.slice(arrayStart, arrayEnd + 1);

  return null;
}

function extractExerciseList(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return null;
  return Array.isArray(record.exercises) ? record.exercises : null;
}

/* ------------------------------------------------------------------ */
/* 单题校验                                                            */
/* ------------------------------------------------------------------ */

/** 清洗选项：只保留非空字符串，并按归一化结果去重。 */
function sanitizeOptions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;

  const options: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const option = item.trim();
    if (!option) continue;
    const key = normalizeAnswer(option);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  return options;
}

/**
 * 校验选择题答案：
 * 1) 优先精确匹配选项；
 * 2) 否则按 normalizeAnswer 归一化匹配，唯一命中则修正为选项原文；
 * 3) 再容忍模型给答案加了 "A." / "1." 之类序号。
 */
function resolveChoiceAnswer(answer: string, options: string[]): string | null {
  if (options.includes(answer)) return answer;

  const normalizedAnswer = normalizeAnswer(answer);
  if (!normalizedAnswer) return null;

  const matches = options.filter((option) => normalizeAnswer(option) === normalizedAnswer);
  if (matches.length === 1) return matches[0];

  const stripped = answer.replace(/^[A-Da-d0-9][).、,:：\s]+/, '').trim();
  if (stripped && stripped !== answer) {
    if (options.includes(stripped)) return stripped;
    const strippedNormalized = normalizeAnswer(stripped);
    const strippedMatches = options.filter((option) => normalizeAnswer(option) === strippedNormalized);
    if (strippedMatches.length === 1) return strippedMatches[0];
  }

  return null;
}

/** 合并填空的等价答案：answer 必在首位，去空、去重、限制数量。 */
function mergeAcceptableAnswers(answer: string, value: unknown): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  const push = (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed) return;
    const key = normalizeAnswer(trimmed);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(trimmed);
  };

  push(answer);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') push(item);
    }
  }

  return merged.slice(0, MAX_FILL_ACCEPTABLE_ANSWERS);
}

/** difficulty 归一化：数字或数字字符串，四舍五入后 clamp 到 1~5，其余默认 3。 */
function normalizeDifficulty(value: unknown): number {
  let numeric: number;
  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    numeric = Number(value);
  } else {
    return 3;
  }
  if (!Number.isFinite(numeric)) return 3;
  return clamp(Math.round(numeric), 1, 5);
}

function createExercise(
  base: Pick<Exercise, 'wordId' | 'type' | 'prompt' | 'answer' | 'explanation' | 'difficulty'>,
  extras: Pick<Exercise, 'options' | 'acceptableAnswers'>,
): Exercise {
  const exercise: Exercise = {
    id: uid('ex'),
    wordId: base.wordId,
    type: base.type,
    prompt: base.prompt,
    answer: base.answer,
    explanation: base.explanation,
    difficulty: base.difficulty,
    source: 'llm',
  };
  if (extras.options !== undefined) exercise.options = extras.options;
  if (extras.acceptableAnswers !== undefined) exercise.acceptableAnswers = extras.acceptableAnswers;
  return exercise;
}

/** 校验并规范化单道题；不合法返回 null。 */
function sanitizeExercise(rawItem: unknown, targetIds: Set<string>): Exercise | null {
  const record = asRecord(rawItem);
  if (!record) return null;

  const wordId = typeof record.wordId === 'string' ? record.wordId.trim() : '';
  if (!wordId || !targetIds.has(wordId)) return null;

  const type = record.type;
  if (!isExerciseType(type)) return null;

  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) return null;

  const explanationText = typeof record.explanation === 'string' ? record.explanation.trim() : '';
  if (!explanationText) return null;
  const explanation = clampText(explanationText, MAX_EXPLANATION_LENGTH);

  const answerText = typeof record.answer === 'string' ? record.answer.trim() : '';
  if (!answerText) return null;

  const difficulty = normalizeDifficulty(record.difficulty);
  const base = { wordId, type, prompt, answer: answerText, explanation, difficulty };

  if (type === 'fill') {
    if (!BLANK_PATTERN.test(prompt)) return null;
    return createExercise(base, {
      acceptableAnswers: mergeAcceptableAnswers(answerText, record.acceptableAnswers),
    });
  }

  const options = sanitizeOptions(record.options);
  if (!options || options.length < 3 || options.length > 4) return null;

  const answer = resolveChoiceAnswer(answerText, options);
  if (!answer) return null;

  // 打乱选项，避免正确答案总在固定位置。
  return createExercise({ ...base, answer }, { options: shuffle(options) });
}

/* ------------------------------------------------------------------ */
/* 解析 + 汇总                                                         */
/* ------------------------------------------------------------------ */

interface ParsedExerciseResult {
  exercises: Exercise[];
  /** 模型原始给出的题目条数（用于区分「没给题」与「给的题全不合法」）。 */
  received: number;
}

function collectExercises(
  raw: string,
  request: Pick<ExerciseRequest, 'targets' | 'count'>,
): ParsedExerciseResult {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) {
    throw new LLMError('parse', '模型返回的内容里没有找到 JSON，请重试或更换模型。', truncateSnippet(raw));
  }

  let payload: unknown;
  try {
    payload = JSON.parse(candidate) as unknown;
  } catch (error) {
    throw new LLMError(
      'parse',
      '模型返回的 JSON 无法解析，请重试或更换模型。',
      error instanceof Error ? error.message : undefined,
    );
  }

  const list = extractExerciseList(payload);
  if (!list) {
    throw new LLMError('parse', '模型返回的 JSON 缺少 exercises 数组，请重试或更换模型。', truncateSnippet(candidate));
  }

  const targetIds = new Set(request.targets.map((target) => target.word.id));
  const limit = Number.isFinite(request.count) ? Math.max(0, Math.floor(request.count)) : list.length;
  const seen = new Set<string>();
  const perTarget = new Map<string, number>();
  const exercises: Exercise[] = [];

  for (const rawItem of list) {
    if (exercises.length >= limit) break;

    const exercise = sanitizeExercise(rawItem, targetIds);
    if (!exercise) continue;

    const dedupeKey = `${exercise.wordId}|${exercise.type}|${normalizeAnswer(exercise.prompt)}`;
    if (seen.has(dedupeKey)) continue;

    const used = perTarget.get(exercise.wordId) ?? 0;
    if (used >= MAX_PER_TARGET) continue;

    seen.add(dedupeKey);
    perTarget.set(exercise.wordId, used + 1);
    exercises.push(exercise);
  }

  return { exercises, received: list.length };
}

/** 解析并校验模型输出；至少返回 1 道题，否则抛 LLMError('parse' | 'empty')。 */
export function parseExercises(
  raw: string,
  request: Pick<ExerciseRequest, 'targets' | 'count'>,
): Exercise[] {
  const result = collectExercises(raw, request);

  if (result.exercises.length > 0) return result.exercises;
  if (result.received === 0) {
    throw new LLMError('empty', '模型没有生成任何题目，请重试或更换模型。');
  }
  throw new LLMError(
    'parse',
    '模型返回的题目都不符合自动判分要求（选项或答案不合法），已全部丢弃，请重试。',
  );
}

/* ------------------------------------------------------------------ */
/* 对外主函数                                                          */
/* ------------------------------------------------------------------ */

/** 根据错词上下文生成可自动判分的练习题。 */
export async function generateExercises(request: ExerciseRequest): Promise<Exercise[]> {
  const { settings, targets, count, signal, onProgress } = request;

  if (!hasUsableLLMConfig(settings)) {
    throw new LLMError(
      'config',
      '还没有配置 LLM：请到设置页填写 Base URL 与模型名（API Key 可留空以支持本地 Ollama）。',
    );
  }
  if (targets.length === 0) {
    throw new LLMError('empty', '当前没有需要针对性出题的错词。');
  }
  if (!Number.isFinite(count) || count <= 0) {
    throw new LLMError('empty', '出题数量无效，请重试。');
  }
  if (signal?.aborted) throw new LLMError('aborted', '生成已取消。');

  onProgress?.('正在整理错词…');

  let raw: string;
  try {
    raw = await chatComplete(settings, buildMessages(request), {
      signal,
      jsonMode: true,
    });
  } catch (error) {
    if (error instanceof LLMError) throw error;
    throw new LLMError(
      'network',
      '调用 LLM 失败，请检查网络与接口配置。',
      error instanceof Error ? error.message : String(error),
    );
  }

  if (signal?.aborted) throw new LLMError('aborted', '生成已取消。');
  if (!raw.trim()) {
    throw new LLMError('empty', '模型返回了空内容，请重试或更换模型。');
  }

  onProgress?.('正在校验题目…');

  return parseExercises(raw, { targets, count });
}
