/**
 * AI 讲解与互译判分（v3：Question + skill，无出题层）。
 */

import type { LLMSettings, Question, Skill, TranslationVerdict, Word } from '@/domain/types';
import { isTranslation } from '@/domain/practice';
import { normalizeAnswer } from '@/domain/utils';
import { createT, DEFAULT_LOCALE, type Locale, type TranslateFn } from '@/i18n';
import { buildAnswerFeedbackMessages, buildTranslationMessages } from './feedbackPrompts';
import { streamChat } from './forward';

export type FeedbackStatus = 'ok' | 'failed' | 'local-fallback';

export interface AnswerFeedbackInput {
  word: Word;
  question: Question;
  response: string;
}

export interface AnswerFeedback {
  explanation: string;
  improvement?: string;
  status: FeedbackStatus;
}

export interface TranslateGradeInput {
  word: Word;
  question: Question;
  response: string;
}

export interface TranslationGrade {
  verdict: TranslationVerdict;
  explanation: string;
  improvement?: string;
  status: FeedbackStatus;
}

export interface AnswerFeedbackStreamOptions {
  signal?: AbortSignal;
  onToken?: (chunk: string) => void;
  timeoutMs?: number;
  locale?: Locale;
}

export interface TranslationGradeStreamOptions {
  signal?: AbortSignal;
  onToken?: (chunk: string) => void;
  onVerdict?: (verdict: TranslationVerdict) => void;
  timeoutMs?: number;
  locale?: Locale;
}

export const FEEDBACK_TIMEOUT_MS = 30_000;
export const EXPLANATION_MAX = 400;

const IMPROVEMENT_LABEL_RE = /(?:改进(?:建议)?|Improvement(?:\s+suggestion)?)\s*[:：]/i;
const VERDICT_LINE_RE = /^\s*VERDICT\s*[:：]\s*(perfect|good|poor)(?![a-zA-Z])/i;
const VERDICT_ANY_RE = /VERDICT\s*[:：]\s*(perfect|good|poor)(?![a-zA-Z])/i;

const SKILL_SUFFIX: Record<Skill, string> = {
  en2zh: 'En2zh',
  zh2en: 'Zh2en',
  spell: 'Spell',
  listen: 'Listen',
  sentence: 'Sentence',
  translate: 'Translate',
};

const ENCOURAGEMENT_COUNT = 12;

function resolveT(locale?: Locale): TranslateFn {
  return createT(locale ?? DEFAULT_LOCALE);
}

function sanitizePlainText(text: string): string {
  return text
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function scrubApiKey(text: string, settings: LLMSettings, t: TranslateFn): string {
  const key = (settings?.apiKey ?? '').trim();
  if (key.length < 8) return text;
  return text.split(key).join(t('feedback.hiddenApiKey'));
}

export function parseFeedbackImprovement(text: string): string | undefined {
  if (!text) return undefined;

  const match = IMPROVEMENT_LABEL_RE.exec(text);
  if (!match) return undefined;

  let rest = text.slice(match.index + match[0].length);
  const nextLabel =
    /(?:错因|记忆点|改进(?:建议)?|Cause|Memory|Improvement(?:\s+suggestion)?)\s*[:：]/i.exec(rest);
  if (nextLabel) rest = rest.slice(0, nextLabel.index);

  const cleaned = rest.trim();
  return cleaned ? cleaned : undefined;
}

function extractSection(text: string, label: string): string | undefined {
  const re = new RegExp(`${label}\\s*[:：]\\s*([^\\n]*)`);
  const match = re.exec(text);
  if (!match) return undefined;
  const value = match[1].trim();
  return value ? value : undefined;
}

function skillFocus(t: TranslateFn, skill?: Skill): string {
  if (!skill) return t('feedback.focusFallback');
  return t(`feedback.focus${SKILL_SUFFIX[skill]}`);
}

function skillReason(t: TranslateFn, skill?: Skill): string {
  if (!skill) return t('feedback.reasonFallback');
  return t(`feedback.reason${SKILL_SUFFIX[skill]}`);
}

function buildLocalImprovement(word: Word, skill: Skill | undefined, t: TranslateFn): string {
  switch (skill) {
    case 'spell':
      return t('feedback.improveSpell', { term: word.term });
    case 'listen':
      return t('feedback.improveListen');
    case 'zh2en':
      return t('feedback.improveZh2en', { meaning: word.meaning });
    case 'en2zh':
      return t('feedback.improveEn2zh', { term: word.term });
    case 'sentence':
      return t('feedback.improveSentence');
    case 'translate':
      return t('feedback.improveTranslate', { term: word.term });
    default:
      return t('feedback.improveDefault');
  }
}

export function localAnswerFeedback(
  input: AnswerFeedbackInput,
  locale: Locale = DEFAULT_LOCALE,
): AnswerFeedback {
  const t = resolveT(locale);
  const { word, question, response } = input;
  const userAnswer = response.trim();
  const correctAnswer = question.answer.trim();
  const skill = question.skill;
  const skillText = skill ? t(`domain.skill.${skill}.label`) : t('feedback.skillFallback');
  const focus = skillFocus(t, skill);
  const reason = skillReason(t, skill);

  const cause = userAnswer
    ? t('feedback.causeWithAnswer', {
        user: userAnswer,
        correct: correctAnswer,
        skill: skillText,
        term: word.term,
        focus,
        reason,
      })
    : t('feedback.causeBlank', {
        skill: skillText,
        correct: correctAnswer,
        term: word.term,
        focus,
      });

  const parsed = (question.explanation ?? '').trim();
  const pos = word.partOfSpeech ? t('domain.practice.posWrap', { pos: word.partOfSpeech }) : '';
  const memory =
    parsed ||
    t('feedback.memoryFallback', { term: word.term, pos, meaning: word.meaning });

  const improvement = buildLocalImprovement(word, skill, t);
  const explanation = `${t('feedback.sectionCause')}: ${cause}\n${t('feedback.sectionMemory')}: ${memory}\n${t('feedback.sectionImprovement')}: ${improvement}`;

  return { explanation, improvement, status: 'local-fallback' };
}

export async function streamAnswerFeedback(
  input: AnswerFeedbackInput,
  settings: LLMSettings,
  options: AnswerFeedbackStreamOptions = {},
): Promise<AnswerFeedback> {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const t = resolveT(locale);

  if (isTranslation(input.question)) {
    return localAnswerFeedback(input, locale);
  }

  try {
    const messages = buildAnswerFeedbackMessages(input);
    let carry = '';
    const emitSafe = (token: string): void => {
      const key = (settings?.apiKey ?? '').trim();
      const buffer = carry + token;
      if (key.length < 8) {
        carry = '';
        options.onToken?.(buffer);
        return;
      }
      const hold = key.length - 1;
      if (buffer.length <= hold) {
        carry = buffer;
        return;
      }
      const emit = buffer.slice(0, buffer.length - hold);
      carry = buffer.slice(buffer.length - hold);
      options.onToken?.(scrubApiKey(emit, settings, t));
    };

    const full = await streamChat(settings, messages, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? FEEDBACK_TIMEOUT_MS,
      maxTokens: 600,
      temperature: 0.3,
      noThink: true,
      onToken: (token: string) => {
        emitSafe(token);
      },
    });

    const text = sanitizePlainText(scrubApiKey(full, settings, t));
    if (!text) return localAnswerFeedback(input, locale);

    const improvement = parseFeedbackImprovement(text);
    return {
      explanation: text,
      ...(improvement ? { improvement } : {}),
      status: 'ok',
    };
  } catch {
    return localAnswerFeedback(input, locale);
  }
}

function levenshtein(a: string, b: string): number {
  const s = a.slice(0, 240);
  const t = b.slice(0, 240);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  let prev = new Array<number>(t.length + 1);
  let curr = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;

  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[t.length];
}

function charSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

function tokenSimilarity(a: string, b: string): number {
  const left = new Set(a.split(' ').filter(Boolean));
  const right = new Set(b.split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  left.forEach((token) => {
    if (right.has(token)) intersection += 1;
  });
  return intersection / (left.size + right.size - intersection);
}

function textSimilarity(a: string, b: string): number {
  if (/\s/.test(a) || /\s/.test(b)) {
    return Math.max(tokenSimilarity(a, b), charSimilarity(a, b) * 0.6);
  }
  return charSimilarity(a, b);
}

const LOCAL_SIMILARITY_THRESHOLD = 0.4;

export function localTranslationGrade(
  input: TranslateGradeInput,
  locale: Locale = DEFAULT_LOCALE,
): TranslationGrade {
  const t = resolveT(locale);
  const { word, question, response } = input;
  const userText = response.trim();
  const reference = question.answer.trim();

  const normalizedUser = normalizeAnswer(userText);
  const normalizedReference = normalizeAnswer(reference);

  let verdict: TranslationVerdict;
  let explanation: string;

  if (!normalizedUser) {
    verdict = 'poor';
    explanation = t('feedback.trBlank', { reference });
  } else if (normalizedUser === normalizedReference) {
    verdict = 'perfect';
    explanation = t('feedback.trPerfect', { user: userText, reference });
  } else {
    const similarity = textSimilarity(normalizedUser, normalizedReference);
    if (similarity >= LOCAL_SIMILARITY_THRESHOLD) {
      verdict = 'good';
      explanation = t('feedback.trGood', { user: userText, reference });
    } else {
      verdict = 'poor';
      explanation = t('feedback.trPoor', { user: userText, reference });
    }
  }

  let improvement: string;
  if (verdict === 'perfect') {
    improvement = t('feedback.trImprovePerfect', { term: word.term });
  } else if (verdict === 'good') {
    improvement = t('feedback.trImproveGood', { reference });
  } else {
    improvement = t('feedback.trImprovePoor', { reference });
  }

  return {
    verdict,
    explanation: `${explanation}\n${t('feedback.sectionImprovement')}: ${improvement}`,
    improvement,
    status: 'local-fallback',
  };
}

export function parseTranslationVerdict(text: string): TranslationVerdict | null {
  if (!text) return null;

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = VERDICT_LINE_RE.exec(line);
    if (match) return match[1].toLowerCase() as TranslationVerdict;
  }

  const fallback = VERDICT_ANY_RE.exec(text);
  return fallback ? (fallback[1].toLowerCase() as TranslationVerdict) : null;
}

const MAX_HEAD_LEN = 512;
const HOLD_LEN = 256;
const VERDICT_SEARCH_LINES = 5;

interface TranslationStreamParser {
  push: (chunk: string) => void;
  finish: () => { verdict: TranslationVerdict | null; body: string };
}

function createTranslationStreamParser(
  onToken?: (chunk: string) => void,
  onVerdict?: (verdict: TranslationVerdict) => void,
): TranslationStreamParser {
  let pending = '';
  let headDone = false;
  let protocol = false;
  let body = '';
  let emitted = 0;
  let hold = 0;
  let verdict: TranslationVerdict | null = null;
  let verdictFired = false;

  const setVerdict = (value: TranslationVerdict): void => {
    if (!verdict) verdict = value;
    if (!verdictFired) {
      verdictFired = true;
      onVerdict?.(value);
    }
  };

  const emitUpTo = (limit: number): void => {
    const end = Math.min(limit, body.length);
    if (end <= emitted) return;
    const chunk = body.slice(emitted, end);
    emitted = end;
    onToken?.(chunk);
  };

  const removeVerdictLine = (index: number): void => {
    const lineStart = body.lastIndexOf('\n', index) + 1;
    let lineEnd = body.indexOf('\n', index);
    if (lineEnd === -1) lineEnd = body.length;
    const removedLength = lineEnd - lineStart;

    if (emitted > lineStart) {
      emitted = emitted > lineEnd ? emitted - removedLength : lineStart;
    }
    body = body.slice(0, lineStart) + body.slice(lineEnd);
  };

  const processNonProtocol = (): void => {
    const searchArea = body.split('\n').slice(0, VERDICT_SEARCH_LINES).join('\n');
    const match = VERDICT_ANY_RE.exec(searchArea);
    if (match) {
      setVerdict(match[1].toLowerCase() as TranslationVerdict);
      removeVerdictLine(match.index);
      hold = 0;
    }
    emitUpTo(Math.max(0, body.length - hold));
  };

  const process = (): void => {
    if (!headDone) {
      const newlineIndex = pending.indexOf('\n');
      if (newlineIndex === -1) {
        const headMatch = VERDICT_LINE_RE.exec(pending);
        if (headMatch) setVerdict(headMatch[1].toLowerCase() as TranslationVerdict);

        if (pending.length <= MAX_HEAD_LEN) return;

        headDone = true;
        protocol = false;
        body = pending;
        pending = '';
        hold = HOLD_LEN;
      } else {
        const firstLine = pending.slice(0, newlineIndex);
        const rest = pending.slice(newlineIndex + 1);
        pending = '';

        const match = VERDICT_LINE_RE.exec(firstLine);
        if (match) {
          headDone = true;
          protocol = true;
          setVerdict(match[1].toLowerCase() as TranslationVerdict);
          body = rest;
          emitUpTo(body.length);
          return;
        }

        headDone = true;
        protocol = false;
        body = `${firstLine}\n${rest}`;
        hold = HOLD_LEN;
      }
    }

    if (protocol) {
      body += pending;
      pending = '';
      emitUpTo(body.length);
      return;
    }

    body += pending;
    pending = '';
    processNonProtocol();
  };

  return {
    push(chunk: string): void {
      if (!chunk) return;
      pending += chunk;
      process();
    },
    finish(): { verdict: TranslationVerdict | null; body: string } {
      process();
      if (!verdict) {
        const match = VERDICT_ANY_RE.exec(body);
        if (match) {
          setVerdict(match[1].toLowerCase() as TranslationVerdict);
          removeVerdictLine(match.index);
        }
      }
      emitUpTo(body.length);
      return { verdict, body };
    },
  };
}

export async function streamTranslationGrade(
  input: TranslateGradeInput,
  settings: LLMSettings,
  options: TranslationGradeStreamOptions = {},
): Promise<TranslationGrade> {
  const locale = options.locale ?? DEFAULT_LOCALE;

  if (!isTranslation(input.question)) {
    return localTranslationGrade(input, locale);
  }

  const t = resolveT(locale);

  try {
    const messages = buildTranslationMessages(input);
    const parser = createTranslationStreamParser(options.onToken, options.onVerdict);

    await streamChat(settings, messages, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? FEEDBACK_TIMEOUT_MS,
      maxTokens: 600,
      temperature: 0,
      noThink: true,
      onToken: (token: string) => {
        parser.push(token);
      },
    });

    const result = parser.finish();
    if (!result.verdict) return localTranslationGrade(input, locale);

    const text = sanitizePlainText(scrubApiKey(result.body, settings, t));
    if (!text) return localTranslationGrade(input, locale);

    const improvement = parseFeedbackImprovement(text);
    return {
      verdict: result.verdict,
      explanation: text,
      ...(improvement ? { improvement } : {}),
      status: 'ok',
    };
  } catch {
    return localTranslationGrade(input, locale);
  }
}

function hash32(value: number): number {
  let x = Math.imul(Math.trunc(value) ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

let lastEncouragementIndex = -1;

export function encouragement(seed?: number, locale: Locale = DEFAULT_LOCALE): string {
  const t = resolveT(locale);
  let index: number;
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    index = hash32(seed) % ENCOURAGEMENT_COUNT;
  } else {
    index = Math.floor(Math.random() * ENCOURAGEMENT_COUNT);
  }

  if (index === lastEncouragementIndex) {
    index = (index + 1) % ENCOURAGEMENT_COUNT;
  }
  lastEncouragementIndex = index;

  return t(`feedback.encouragement${index}`);
}

export function parseFeedbackSections(
  text: string,
  locale: Locale = DEFAULT_LOCALE,
): {
  cause?: string;
  memory?: string;
  improvement?: string;
} {
  const t = resolveT(locale);
  return {
    cause: extractSection(text, t('feedback.sectionCause')),
    memory: extractSection(text, t('feedback.sectionMemory')),
    improvement: parseFeedbackImprovement(text),
  };
}
