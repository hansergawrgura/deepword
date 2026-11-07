/**
 * AI 讲解与互译判分的提示词（Phase B，契约见 docs/phase-b-contract.md §7）。
 *
 * 设计原则：
 * - 提示词全部中文；输出严格纯文本，禁止 JSON / markdown 代码围栏包装正文；
 * - 答错讲解固定输出「错因 / 记忆点 / 改进」三段，便于 `parseFeedbackImprovement` 本地解析；
 * - 互译判分首行为 `VERDICT: perfect|good|poor` 协议行，空行后才是讲解正文，
 *   便于流式过程中一解析出结论就立即回调。
 * - 提示词里不会携带 API Key，也不会要求模型回显设置信息。
 */

import type { Word } from '../../types';
import type { AnswerFeedbackInput, TranslateGradeInput } from '../feedback';
import type { ChatMessage } from './types';

/** 讲解 / 判分提示词版本号（与出题 PROMPT_VERSION 独立；调整提示词策略时递增）。 */
export const FEEDBACK_PROMPT_VERSION = 'v1';

const ANSWER_FEEDBACK_SYSTEM_PROMPT = `你是一位中文母语的英语词汇教练，负责在学员答错后给出简短、具体、能立刻用上的中文讲解。

硬性规则：
1. 只输出纯文本中文，不要 JSON、不要 markdown 代码围栏、不要编号列表、不要 HTML。
2. 必须严格输出三段，顺序固定，每段以「错因：」「记忆点：」「改进：」开头，每段一行或一小段。
3. 错因：≤60 字，只说清这次具体错在哪个环节（词义混淆 / 拼写 / 搭配 / 听辨 / 语境），不要空泛地说「要多背」。
4. 记忆点：≤80 字，给出一个可复用的记忆钩子（词根词缀、近义辨析、固定搭配或例句），必须围绕目标词。
5. 改进：≤40 字，给出下一次作答可以立刻执行的具体动作。
6. 总字数 ≤200 字；不要复述题干，不要出现「作为 AI」之类的话，不要输出与本次讲解无关的内容。`;

const TRANSLATION_SYSTEM_PROMPT = `你是一位严格而公正的英汉互译判分员，只根据给定的参考译文判断学员译文的质量。

硬性规则：
1. 第一行必须且只能是协议行：VERDICT: perfect / good / poor（三选一，写在 VERDICT 冒号后）。
2. 第一行之后必须空一行，再输出中文讲解正文（纯文本）。
3. 禁止 JSON、markdown 代码围栏、代码块、HTML；不要复述题干。
4. 判分口径：
   - perfect：意思完整准确，表达自然，与参考译文等价（允许同义替换与语序调整）。
   - good：意思基本正确，但存在小瑕疵（轻微漏译、用词不够地道、可理解的小语法问题）。
   - poor：关键信息错误、遗漏，或译文无法理解。
5. 讲解正文 ≤200 字：先指出哪里准确、哪里错误或遗漏，最后一句必须以「改进：」开头给出具体建议。
6. 以参考译文为唯一判据；若学员留白或答非所问，判 poor。`;

/** 目标词的上下文行（双方言共用）。 */
function buildWordContextLines(word: Word): string[] {
  const lines: string[] = [
    `【目标词】${word.term}${word.phonetic ? ` ${word.phonetic}` : ''}`,
    `【词性】${word.partOfSpeech || '未标注'}`,
    `【释义】${word.meaning}`,
  ];
  if (word.example) {
    const translation = word.exampleTranslation ? `（${word.exampleTranslation}）` : '';
    lines.push(`【例句】${word.example}${translation}`);
  }
  return lines;
}

/** 答错讲解的 messages：system 固定，user 携带词条、题目、作答与正确答案。 */
export function buildAnswerFeedbackMessages(input: AnswerFeedbackInput): ChatMessage[] {
  const { word, exercise, response } = input;
  const userLines: string[] = [
    '学员刚刚答错了一道英语练习，请根据下面的信息给出讲解。',
    '',
    ...buildWordContextLines(word),
    '',
    `【题目类型】${exercise.type}${exercise.skill ? `（技能：${exercise.skill}）` : ''}`,
    `【题干】${exercise.prompt}`,
    `【学员作答】${response.trim() || '（留白）'}`,
    `【正确答案】${exercise.answer}`,
  ];
  if (exercise.explanation) userLines.push(`【已有解析】${exercise.explanation}`);
  userLines.push(
    '',
    '请严格按「错因：」「记忆点：」「改进：」三段输出中文纯文本，不要 JSON、不要 markdown，总字数 ≤200 字。',
  );
  return [
    { role: 'system', content: ANSWER_FEEDBACK_SYSTEM_PROMPT },
    { role: 'user', content: userLines.join('\n') },
  ];
}

/** 互译判分的 messages：system 固定，user 携带方向、原题、参考译文与学员译文。 */
export function buildTranslationMessages(input: TranslateGradeInput): ChatMessage[] {
  const { word, exercise, response } = input;
  const direction =
    exercise.direction === 'zh2en'
      ? 'zh2en（中译英：把中文译成英文）'
      : 'en2zh（英译中：把英文译成中文）';

  const userLines: string[] = [
    '请判分下面这道互译题。',
    '',
    `【互译方向】${direction}`,
    ...buildWordContextLines(word),
    '',
    `【题目】${exercise.prompt}`,
    `【参考译文】${exercise.answer}`,
    `【学员译文】${response.trim() || '（留白）'}`,
    '',
    '请严格按以下格式输出：',
    'VERDICT: perfect|good|poor',
    '',
    '讲解正文（中文纯文本，≤200 字，最后一句以「改进：」开头）',
    '只输出上述内容，不要 JSON、不要 markdown 代码围栏、不要复述题干。',
  ];

  return [
    { role: 'system', content: TRANSLATION_SYSTEM_PROMPT },
    { role: 'user', content: userLines.join('\n') },
  ];
}
