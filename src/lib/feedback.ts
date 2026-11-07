/**
 * Phase B 的 AI 讲解与互译判分（契约见 docs/phase-b-contract.md §7）。
 *
 * 设计原则：
 * - 提示词全部由 `./llm/feedbackPrompts` 生成（该文件由同伴维护，本文件只复用、不修改）；
 * - 讲解与判分都走 `streamChat` 流式：讲解按「错因：/记忆点：/改进：」三段输出，
 *   互译按「第一行 VERDICT: perfect|good|poor，空行后是讲解正文」协议输出；
 * - **永不抛错**：未配置 / 网络 / 超时 / 取消 / 解析异常一律降级为本地解析
 *   （status = 'local-fallback'），不阻塞作答；
 * - 讲解正文按纯文本处理（去掉 markdown 围栏与 HTML 标签），不执行 HTML；
 * - 不回显 API Key：输出里若出现配置里的 Key，会被替换掉。
 */

import type { Exercise, LLMSettings, Skill, TranslationVerdict, Word } from '../types';
import { normalizeAnswer } from './utils';
import { buildAnswerFeedbackMessages, buildTranslationMessages } from './llm/feedbackPrompts';
import { streamChat } from './llm/providers';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 讲解 / 判分的产出状态。 */
export type FeedbackStatus = 'ok' | 'failed' | 'local-fallback';

/** 答错讲解的输入。 */
export interface AnswerFeedbackInput {
  word: Word;
  exercise: Exercise;
  response: string;
}

/** 答错讲解的结果。 */
export interface AnswerFeedback {
  /** 完整讲解文本：错因 + 记忆点 + 改进（未经 400 字截断，截断由调用方落库时做）。 */
  explanation: string;
  /** 「改进」段的内容（不含「改进：」标签）。 */
  improvement?: string;
  status: FeedbackStatus;
}

/** 互译判分的输入。 */
export interface TranslateGradeInput {
  word: Word;
  exercise: Exercise;
  response: string;
}

/** 互译判分的结果。 */
export interface TranslationGrade {
  /** 三档判定。 */
  verdict: TranslationVerdict;
  /** 讲解正文（纯文本）。 */
  explanation: string;
  /** 「改进」段的内容（不含「改进：」标签）。 */
  improvement?: string;
  status: FeedbackStatus;
}

/** 答错讲解的流式选项。 */
export interface AnswerFeedbackStreamOptions {
  /** 取消信号。 */
  signal?: AbortSignal;
  /** 每收到一段文本回调一次（实时回传讲解正文）。 */
  onToken?: (chunk: string) => void;
  /** 覆盖默认超时（毫秒）。 */
  timeoutMs?: number;
}

/** 互译判分的流式选项。 */
export interface TranslationGradeStreamOptions {
  /** 取消信号。 */
  signal?: AbortSignal;
  /** 每收到一段文本回调一次（只回传讲解正文，不含 VERDICT 行）。 */
  onToken?: (chunk: string) => void;
  /** 一解析出判定档位立刻回调。 */
  onVerdict?: (verdict: TranslationVerdict) => void;
  /** 覆盖默认超时（毫秒）。 */
  timeoutMs?: number;
}

/** 讲解 / 判分的默认超时（毫秒）：学习流程里不宜久等。 */
export const FEEDBACK_TIMEOUT_MS = 30_000;

/** 讲解落库时的最大长度（存储截断用；流式展示可见全文）。 */
export const EXPLANATION_MAX = 400;

/* ------------------------------------------------------------------ */
/* 文本工具                                                            */
/* ------------------------------------------------------------------ */

/** 「改进」标签（可出现在行首或行内）。 */
const IMPROVEMENT_LABEL_RE = /改进(?:建议)?\s*[:：]/;

/** 互译协议行：`VERDICT: perfect|good|poor`。 */
const VERDICT_LINE_RE = /^\s*VERDICT\s*[:：]\s*(perfect|good|poor)(?![a-zA-Z])/i;

/** 互译协议行（允许出现在任意位置，用于容错兜底）。 */
const VERDICT_ANY_RE = /VERDICT\s*[:：]\s*(perfect|good|poor)(?![a-zA-Z])/i;

/** 把讲解正文清洗成纯文本：去 markdown 围栏行、去 HTML 标签、压缩空行。 */
function sanitizePlainText(text: string): string {
  return text
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 输出里若混入了配置中的 API Key，替换掉，避免密钥外泄。 */
function scrubApiKey(text: string, settings: LLMSettings): string {
  const key = (settings?.apiKey ?? '').trim();
  if (key.length < 8) return text;
  return text.split(key).join('「已隐藏」');
}

/**
 * 提取「改进：」段的内容（不含标签本身）。
 * 没找到时返回 undefined。
 */
export function parseFeedbackImprovement(text: string): string | undefined {
  if (!text) return undefined;

  const match = IMPROVEMENT_LABEL_RE.exec(text);
  if (!match) return undefined;

  let rest = text.slice(match.index + match[0].length);
  // 「改进」段之后若又出现段落标签，则在此截断。
  const nextLabel = /错因\s*[:：]|记忆点\s*[:：]|改进(?:建议)?\s*[:：]/.exec(rest);
  if (nextLabel) rest = rest.slice(0, nextLabel.index);

  const cleaned = rest.trim();
  return cleaned ? cleaned : undefined;
}

/** 取一段文本中的「错因」「记忆点」段（内部使用，便于组装结构化讲解）。 */
function extractSection(text: string, label: string): string | undefined {
  const re = new RegExp(`${label}\\s*[:：]\\s*([^\\n]*)`);
  const match = re.exec(text);
  if (!match) return undefined;
  const value = match[1].trim();
  return value ? value : undefined;
}

/* ------------------------------------------------------------------ */
/* 本地降级讲解                                                        */
/* ------------------------------------------------------------------ */

/** 各技能的中文名（本地降级讲解用，不依赖出题层，避免跨模块耦合）。 */
const SKILL_LABEL: Record<Skill, string> = {
  en2zh: '英译中',
  zh2en: '中译英',
  spell: '拼写',
  listen: '听音',
  sentence: '例句',
  translate: '互译',
};

/** 各技能考查的落点（本地降级讲解用）。 */
const SKILL_FOCUS: Record<Skill, string> = {
  en2zh: '中文释义',
  zh2en: '英文词形',
  spell: '准确拼写',
  listen: '听辨发音',
  sentence: '语境搭配',
  translate: '意思表达',
};

/** 各技能常见错因（本地降级讲解用）。 */
const SKILL_REASON: Record<Skill, string> = {
  en2zh: '多半是与近义释义混淆了',
  zh2en: '多半是近义词没对上号',
  spell: '常见漏字母、多字母或词尾形式有误',
  listen: '常见是发音没听清',
  sentence: '常见是忽略了前后文的搭配',
  translate: '常见是漏译或译错了关键信息',
};

/** 生成本地「改进」建议。 */
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

/**
 * 本地降级讲解：不依赖 AI，直接用题目的解析、正确答案与用户作答拼出
 * 「错因 / 记忆点 / 改进」三段中文讲解。
 */
export function localAnswerFeedback(input: AnswerFeedbackInput): AnswerFeedback {
  const { word, exercise, response } = input;
  const userAnswer = response.trim();
  const correctAnswer = exercise.answer.trim();
  const skill = exercise.skill;
  const skillText = skill ? SKILL_LABEL[skill] : '练习';
  const focus = skill ? SKILL_FOCUS[skill] : '词义';
  const reason = skill ? SKILL_REASON[skill] : '多半是对词义的理解有偏差';

  const cause = userAnswer
    ? `你答的是「${userAnswer}」，正确答案是「${correctAnswer}」；这道${skillText}题考的是「${word.term}」的${focus}，${reason}。`
    : `你留白了；这道${skillText}题的正确答案是「${correctAnswer}」，考的是「${word.term}」的${focus}。`;

  const parsed = (exercise.explanation ?? '').trim();
  const memory = parsed || `${word.term}${word.partOfSpeech ? `（${word.partOfSpeech}）` : ''}：${word.meaning}`;

  const improvement = buildLocalImprovement(word, skill);
  const explanation = `错因：${cause}\n记忆点：${memory}\n改进：${improvement}`;

  return { explanation, improvement, status: 'local-fallback' };
}

/* ------------------------------------------------------------------ */
/* 答错讲解（流式）                                                    */
/* ------------------------------------------------------------------ */

/**
 * 流式生成答错讲解。
 * 成功时 status = 'ok'；任何失败（未配置 / 网络 / 超时 / 取消 / 解析异常）
 * 都降级为 `localAnswerFeedback`，**永不抛错**。
 */
export async function streamAnswerFeedback(
  input: AnswerFeedbackInput,
  settings: LLMSettings,
  options: AnswerFeedbackStreamOptions = {},
): Promise<AnswerFeedback> {
  try {
    const messages = buildAnswerFeedbackMessages(input);
    // 流式增量也要脱敏：保留 key.length-1 个字符的窗口，避免 Key 跨 chunk 拼出。
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
    // 未配置 / 网络 / 超时 / 取消 / 解析异常 —— 一律本地降级，不阻塞作答。
    return localAnswerFeedback(input);
  }
}

/* ------------------------------------------------------------------ */
/* 互译判分（本地 + 流式）                                             */
/* ------------------------------------------------------------------ */

/** 字符级编辑距离（带长度上限，避免长文本拖慢）。 */
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

/** 字符级相似度（0~1）。 */
function charSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

/** 词级 Jaccard 相似度（英文译文用）。 */
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

/** 综合相似度（0~1）。 */
function textSimilarity(a: string, b: string): number {
  // 有词边界（英文译文）时以词级为主：字符级相似度对英文句子会明显高估
  // （长度相近但用词完全不同的两句，字符相似度也可能过半），因此打 0.6 折。
  if (/\s/.test(a) || /\s/.test(b)) {
    return Math.max(tokenSimilarity(a, b), charSimilarity(a, b) * 0.6);
  }
  // 中文译文没有词边界，用字符级相似度即可。
  return charSimilarity(a, b);
}

/** 本地判定的「近似」阈值。 */
const LOCAL_SIMILARITY_THRESHOLD = 0.4;

/**
 * 本地降级判分：把用户译文与参考译文归一化后比对。
 * 完全一致 → perfect；近似 → good；明显不同（或留白）→ poor。
 */
export function localTranslationGrade(input: TranslateGradeInput): TranslationGrade {
  const { word, exercise, response } = input;
  const userText = response.trim();
  const reference = exercise.answer.trim();

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

/** 从文本里解析互译判定档位；解析不到返回 null。 */
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

/* ------------------------------------------------------------------ */
/* 互译判分流式解析器                                                  */
/* ------------------------------------------------------------------ */

/** 首行超过这个长度还没换行，就不再当作协议头，整段当正文处理。 */
const MAX_HEAD_LEN = 512;

/** 非协议模式下暂缓输出的尾部长度（避免把半截判决行推给 UI）。 */
const HOLD_LEN = 256;

/** 非协议模式下最多在前几行里找判决行。 */
const VERDICT_SEARCH_LINES = 5;

interface TranslationStreamParser {
  push: (chunk: string) => void;
  finish: () => { verdict: TranslationVerdict | null; body: string };
}

/**
 * 互译判分的流式解析器：
 * - 协议模式（第一行是 `VERDICT: xxx`）：一解析出判定立刻回调 onVerdict，
 *   onToken 只收到空行之后的讲解正文；
 * - 非协议模式（模型没按协议输出）：容错扫描正文前几行找判定行，
 *   找到后同样回调 onVerdict，并把该行从正文里剔除。
 */
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

  /** 把 body 中 [emitted, limit) 推给 UI。 */
  const emitUpTo = (limit: number): void => {
    const end = Math.min(limit, body.length);
    if (end <= emitted) return;
    const chunk = body.slice(emitted, end);
    emitted = end;
    onToken?.(chunk);
  };

  /** 从正文中移除一整行判定行，并修正已输出长度。 */
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

  /** 非协议模式：在正文前几行里找判定行并处理输出。 */
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
        // 还没换行：可能判决行已经完整，先行判定以便立刻回调。
        const headMatch = VERDICT_LINE_RE.exec(pending);
        if (headMatch) setVerdict(headMatch[1].toLowerCase() as TranslationVerdict);

        if (pending.length <= MAX_HEAD_LEN) return;

        // 超长且无换行：整段当作正文。
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

        // 第一行不是判定行：整段按正文处理，后面再容错找判定行。
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

/**
 * 流式互译判分。
 * 成功时 status = 'ok'；任何失败（未配置 / 网络 / 超时 / 取消 / 协议解析失败）
 * 都降级为 `localTranslationGrade`，**永不抛错**。
 */
export async function streamTranslationGrade(
  input: TranslateGradeInput,
  settings: LLMSettings,
  options: TranslationGradeStreamOptions = {},
): Promise<TranslationGrade> {
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
    // 未配置 / 网络 / 超时 / 取消 —— 一律本地降级，不阻塞作答。
    return localTranslationGrade(input);
  }
}

/* ------------------------------------------------------------------ */
/* 鼓励语                                                              */
/* ------------------------------------------------------------------ */

/** 本地鼓励语库（答对时使用，避免每次都联网等讲解）。 */
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

/** 整数哈希（用于按 seed 稳定取鼓励语）。 */
function hash32(value: number): number {
  let x = Math.imul(Math.trunc(value) ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/** 上一条鼓励语的下标（用于避免连续重复）。 */
let lastEncouragementIndex = -1;

/**
 * 本地鼓励语。
 * - 传 seed 时按 seed 稳定取（同 seed 结果一致）；
 * - 不传 seed 时随机取；
 * - 两种情况都会避免与上一条重复。
 */
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

/** 内部调试用：取「错因」「记忆点」段（供 UI 需要分段渲染时使用）。 */
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
