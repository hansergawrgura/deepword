/**
 * AI 讲解与互译判分（v3：Question + skill，无出题层）。
 */

import type { LLMSettings, Question, Skill, TranslationVerdict, Word } from '@/domain/types';
import { isTranslation } from '@/domain/practice';
import { normalizeAnswer } from '@/domain/utils';
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
}

export interface TranslationGradeStreamOptions {
  signal?: AbortSignal;
  onToken?: (chunk: string) => void;
  onVerdict?: (verdict: TranslationVerdict) => void;
  timeoutMs?: number;
}

export const FEEDBACK_TIMEOUT_MS = 30_000;
export const EXPLANATION_MAX = 400;

const IMPROVEMENT_LABEL_RE = /改进(?:建议)?\s*[:：]/;
const VERDICT_LINE_RE = /^\s*VERDICT\s*[:：]\s*(perfect|good|poor)(?![a-zA-Z])/i;
const VERDICT_ANY_RE = /VERDICT\s*[:：]\s*(perfect|good|poor)(?![a-zA-Z])/i;

function sanitizePlainText(text: string): string {
  return text
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function scrubApiKey(text: string, settings: LLMSettings): string {
  const key = (settings?.apiKey ?? '').trim();
  if (key.length < 8) return text;
  return text.split(key).join('「已隐藏」');
}

export function parseFeedbackImprovement(text: string): string | undefined {
  if (!text) return undefined;

  const match = IMPROVEMENT_LABEL_RE.exec(text);
  if (!match) return undefined;

  let rest = text.slice(match.index + match[0].length);
  const nextLabel = /错因\s*[:：]|记忆点\s*[:：]|改进(?:建议)?\s*[:：]/.exec(rest);
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

const SKILL_LABEL: Record<Skill, string> = {
  en2zh: '英译中',
  zh2en: '中译英',
  spell: '拼写',
  listen: '听音',
  sentence: '例句',
  translate: '互译',
};

const SKILL_FOCUS: Record<Skill, string> = {
  en2zh: '中文释义',
  zh2en: '英文词形',
  spell: '准确拼写',
  listen: '听辨发音',
  sentence: '语境搭配',
  translate: '意思表达',
};

const SKILL_REASON: Record<Skill, string> = {
  en2zh: '多半是与近义释义混淆了',
  zh2en: '多半是近义词没对上号',
  spell: '常见漏字母、多字母或词尾形式有误',
  listen: '常见是发音没听清',
  sentence: '常见是忽略了前后文的搭配',
  translate: '常见是漏译或译错了关键信息',
};

function buildLocalImprovement(word: Word, skill?: Skill): string {
  switch (skill) {
    case 'spell':
      return `把「${word.term}」拆成音节读三遍再拼写，拼完逐字母核对一遍。`;
    case 'listen':
      return '点击喇叭重听两遍，先跟读一遍，再回到选项排除近义释义。';
    case 'zh2en':
      return `先默念「${word.meaning}」对应的英文词形，再去选项里核对拼写。`;
    case 'en2zh':
      return `先在心里说出「${word.term}」的中文意思，再回到选项逐个排除近义词。`;
    case 'sentence':
      return '把整句连读一遍，按句意判断空格该填哪个词。';
    case 'translate':
      return `先记住「${word.term}」在本句中的意思，再逐词对齐参考译文。`;
    default:
      return '先默念词义再作答，答完回头核对一遍拼写。';
  }
}

export function localAnswerFeedback(input: AnswerFeedbackInput): AnswerFeedback {
  const { word, question, response } = input;
  const userAnswer = response.trim();
  const correctAnswer = question.answer.trim();
  const skill = question.skill;
  const skillText = skill ? SKILL_LABEL[skill] : '练习';
  const focus = skill ? SKILL_FOCUS[skill] : '词义';
  const reason = skill ? SKILL_REASON[skill] : '多半是对词义的理解有偏差';

  const cause = userAnswer
    ? `你答的是「${userAnswer}」，正确答案是「${correctAnswer}」；这道${skillText}题考的是「${word.term}」的${focus}，${reason}。`
    : `你留白了；这道${skillText}题的正确答案是「${correctAnswer}」，考的是「${word.term}」的${focus}。`;

  const parsed = (question.explanation ?? '').trim();
  const memory = parsed || `${word.term}${word.partOfSpeech ? `（${word.partOfSpeech}）` : ''}：${word.meaning}`;

  const improvement = buildLocalImprovement(word, skill);
  const explanation = `错因：${cause}\n记忆点：${memory}\n改进：${improvement}`;

  return { explanation, improvement, status: 'local-fallback' };
}

export async function streamAnswerFeedback(
  input: AnswerFeedbackInput,
  settings: LLMSettings,
  options: AnswerFeedbackStreamOptions = {},
): Promise<AnswerFeedback> {
  if (isTranslation(input.question)) {
    return localAnswerFeedback(input);
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
      options.onToken?.(scrubApiKey(emit, settings));
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

    const text = sanitizePlainText(scrubApiKey(full, settings));
    if (!text) return localAnswerFeedback(input);

    const improvement = parseFeedbackImprovement(text);
    return {
      explanation: text,
      ...(improvement ? { improvement } : {}),
      status: 'ok',
    };
  } catch {
    return localAnswerFeedback(input);
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

export function localTranslationGrade(input: TranslateGradeInput): TranslationGrade {
  const { word, question, response } = input;
  const userText = response.trim();
  const reference = question.answer.trim();

  const normalizedUser = normalizeAnswer(userText);
  const normalizedReference = normalizeAnswer(reference);

  let verdict: TranslationVerdict;
  let explanation: string;

  if (!normalizedUser) {
    verdict = 'poor';
    explanation = `你留白了；参考译文是「${reference}」，这次没有作答，按不正确处理。`;
  } else if (normalizedUser === normalizedReference) {
    verdict = 'perfect';
    explanation = `你的译文「${userText}」与参考译文「${reference}」意思完全一致，判定为完全正确。`;
  } else {
    const similarity = textSimilarity(normalizedUser, normalizedReference);
    if (similarity >= LOCAL_SIMILARITY_THRESHOLD) {
      verdict = 'good';
      explanation = `你的译文「${userText}」与参考译文「${reference}」意思基本对得上，只是措辞或细节上还有差距，判定为基本正确。`;
    } else {
      verdict = 'poor';
      explanation = `你的译文「${userText}」与参考译文「${reference}」差距较大，关键信息可能译错或遗漏，判定为不正确。`;
    }
  }

  let improvement: string;
  if (verdict === 'perfect') {
    improvement = `保持这个表达；下次遇到含「${word.term}」的句子可以先套用这个句式。`;
  } else if (verdict === 'good') {
    improvement = `对照参考译文「${reference}」检查是否漏掉了限定词、介词或时态。`;
  } else {
    improvement = `先按参考译文「${reference}」拆成主语、谓语、宾语三段，再逐段翻译。`;
  }

  return {
    verdict,
    explanation: `${explanation}\n改进：${improvement}`,
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
  if (!isTranslation(input.question)) {
    return localTranslationGrade(input);
  }

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
    if (!result.verdict) return localTranslationGrade(input);

    const text = sanitizePlainText(scrubApiKey(result.body, settings));
    if (!text) return localTranslationGrade(input);

    const improvement = parseFeedbackImprovement(text);
    return {
      verdict: result.verdict,
      explanation: text,
      ...(improvement ? { improvement } : {}),
      status: 'ok',
    };
  } catch {
    return localTranslationGrade(input);
  }
}

const ENCOURAGEMENTS: string[] = [
  '答对了！这个词又稳住了。',
  '正确！继续保持这个节奏。',
  '漂亮，这一题拿下了。',
  '很好，说明这个词你已经记住了。',
  '答对啦，下次复习会更轻松。',
  '不错，这个词算是拿下了。',
  '对得很准，继续保持。',
  '厉害，又少了一个易错点。',
  '稳，这一轮的掌握度在涨。',
  '完全正确，给自己一点掌声。',
  '答得好，记忆正在固化。',
  '通过！这个词可以放心了。',
];

function hash32(value: number): number {
  let x = Math.imul(Math.trunc(value) ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

let lastEncouragementIndex = -1;

export function encouragement(seed?: number): string {
  let index: number;
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    index = hash32(seed) % ENCOURAGEMENTS.length;
  } else {
    index = Math.floor(Math.random() * ENCOURAGEMENTS.length);
  }

  if (index === lastEncouragementIndex) {
    index = (index + 1) % ENCOURAGEMENTS.length;
  }
  lastEncouragementIndex = index;

  return ENCOURAGEMENTS[index];
}

export function parseFeedbackSections(text: string): {
  cause?: string;
  memory?: string;
  improvement?: string;
} {
  return {
    cause: extractSection(text, '错因'),
    memory: extractSection(text, '记忆点'),
    improvement: parseFeedbackImprovement(text),
  };
}
