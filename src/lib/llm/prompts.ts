/**
 * LLM 出题提示词：中文系统提示 + 用户提示，要求模型输出严格纯 JSON。
 *
 * 约束目标：
 * - 所有题目都可自动判分（选择题 answer 精确等于某项；填空题有唯一答案与可接受答案）；
 * - 针对错词的历史表现（wrongCount / correctStreak / recentAccuracy / lastExerciseType）出题；
 * - 干扰项同词性、同语义场、有迷惑性，禁止「以上都对」。
 */

import type { DifficultyPreference } from '../../types';
import type { ChatMessage, ExerciseRequest, ExerciseTarget } from './types';

/** 系统提示词版本号，便于设置页展示与排查同一份提示词的效果。 */
export const PROMPT_VERSION = 'v1';

export const SYSTEM_PROMPT = `你是一位资深英语词汇教研员，长期为中文母语的英语学习者设计可自动判分的词汇练习。你出的题严谨、语境自然、答案唯一，并且能精准打击每个错词的薄弱点。

硬性规则：
1. 只输出纯 JSON（一个对象），不要 markdown 代码围栏，不要注释，不要任何解释文字。
2. 题型只能是 choice / fill / usage / correction：
   - choice：选出目标词的正确词义/辨析；
   - fill：例句填空；
   - usage：选出用法正确的句子；
   - correction：选出修正后的句子。
   usage 与 correction 也是选择题：必须提供 options，且 answer 等于其中某一项的完整原文。
3. 每道题都必须能自动判分：
   - 选择题的 answer 必须与 options 中某一项逐字符完全一致（不要加序号、引号或额外说明）；
   - fill 题的 prompt 必须包含连续下划线 ____ 表示空格，answer 唯一且在语境中自然。
4. 严禁使用「以上都对」「以上都不对」「None of the above」这类选项，严禁出现两个正确选项。
5. 干扰项必须与正确答案同词性、同一语义场、长度相近，具有真实迷惑性；不要用明显荒谬的选项凑数。
6. wordId 只能使用用户提供的错词清单中的 id；每个 wordId 最多出 2 道题。
7. 所有 explanation 使用中文，≤120 字，具体说明正确答案为什么对、最容易混淆的干扰项错在哪里。
8. 输出字段严格为：exercises[].wordId / type / prompt / options / answer / acceptableAnswers / explanation / difficulty。`;

const DIFFICULTY_GUIDE: Record<DifficultyPreference, string> = {
  adaptive:
    'adaptive（自适应）：结合每个词的历史表现调节难度——wrongCount 越高、recentAccuracy 越低、correctStreak 越短，题目越难（可到 4~5）；已连续答对的词保持在 2~3 巩固。',
  foundation:
    'foundation（基础）：以核心词义、常见搭配和基础例句为主，难度控制在 1~2，干扰项相对直白。',
  challenge:
    'challenge（挑战）：侧重近义词辨析、固定搭配、语体与易混用法，难度控制在 3~5，干扰项要有强迷惑性。',
};

/** 把内部 target 整理成发给模型的紧凑 JSON 对象；缺省字段不输出，避免误导模型。 */
function formatTarget(target: ExerciseTarget): Record<string, unknown> {
  const { word } = target;
  const formatted: Record<string, unknown> = {
    wordId: word.id,
    term: word.term,
    meaning: word.meaning,
    wrongCount: target.wrongCount,
    correctStreak: target.correctStreak,
  };

  if (word.partOfSpeech) formatted.partOfSpeech = word.partOfSpeech;
  if (word.phonetic) formatted.phonetic = word.phonetic;
  if (word.example) formatted.example = word.example;
  if (word.exampleTranslation) formatted.exampleTranslation = word.exampleTranslation;
  if (target.srsStatus) formatted.srsStatus = target.srsStatus;
  if (target.lastExerciseType) formatted.lastExerciseType = target.lastExerciseType;
  if (typeof target.recentAccuracy === 'number' && Number.isFinite(target.recentAccuracy)) {
    formatted.recentAccuracy = Math.round(target.recentAccuracy * 100) / 100;
  }
  if (typeof target.lastMistakeAt === 'number' && Number.isFinite(target.lastMistakeAt)) {
    formatted.lastMistakeAt = new Date(target.lastMistakeAt).toISOString();
  }

  return formatted;
}

/** 组装发给 LLM 的 messages：system 固定，user 携带错词清单与输出格式。 */
export function buildMessages(request: ExerciseRequest): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(request) },
  ];
}

export function buildUserPrompt(request: ExerciseRequest): string {
  const count = Math.max(1, Math.floor(request.count));
  const targets = request.targets.map(formatTarget);

  return [
    `请为下面 ${targets.length} 个错词生成 ${count} 道可自动判分的英语练习题。`,
    '',
    '【题型说明】',
    '- choice：四选一，考目标词的词义或近义词辨析；',
    '- fill：例句填空，题干中用 ____ 表示空格；',
    '- usage：四选一，选出目标词用法正确的那句；',
    '- correction：四选一，选出修正错误后的句子。',
    'choice / usage / correction 都必须提供 3~4 个互不相同的 options，answer 等于其中某一项原文；fill 不提供 options。',
    '',
    '【出题策略】',
    '- 优先给 wrongCount 高、recentAccuracy 低、correctStreak 为 0 的词出题；每个 wordId 最多 2 道题。',
    '- 若 lastExerciseType 存在，说明该词上次错在这类题，优先再考一次同类题型，并换一个新的语境。',
    '- 题干或正确选项中必须出现目标词，不要考与目标词无关的语法点。',
    '- 干扰项要与正确答案同词性、同一语义场、长度相近；禁止「以上都对」「以上都不对」「None of the above」，禁止两个正确项。',
    '',
    '【难度档位】',
    DIFFICULTY_GUIDE[request.difficulty],
    'difficulty 用 1~5 的整数表示，数值越大越难。',
    '',
    '【解析要求】',
    'explanation 用中文，≤120 字，讲清正确答案为什么对、最易混淆的干扰项错在哪，不要写「见解析」之类的空话。',
    '',
    '【错词清单】',
    JSON.stringify(targets, null, 2),
    '',
    '【输出格式】',
    '只输出一个纯 JSON 对象，不要 markdown 代码围栏，不要任何解释文字，格式如下：',
    '{"exercises":[{"wordId":"输入中的 wordId","type":"choice","prompt":"题干","options":["选项1","选项2","选项3","选项4"],"answer":"正确选项原文","acceptableAnswers":[],"explanation":"中文解析","difficulty":3}]}',
    `- wordId 必须来自上面的错词清单；`,
    `- 题目总数尽量等于 ${count}，且至少 1 道；`,
    '- fill 题不要输出 options；选择题的 acceptableAnswers 留空数组即可。',
  ].join('\n');
}
