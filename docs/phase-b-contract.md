# Phase B 内部契约（1.1.0 学习流程）

> 本文件由 Team Lead 维护，是 Phase B 并行开发的**接口契约**。实现方只实现、不改签名；
> 需要调整契约先联系 Lead。所有新模块都只依赖 `src/types.ts`、`src/lib/utils.ts` 与
> 既有纯函数，不直接读写 localStorage。
>
> **共享工作区警告**：本仓库同时有另一个会话在修改 LLM/provider 相关文件
> （`src/lib/llm/providers.ts`、`src/lib/llm/prompts.ts`、`src/lib/llm/llm.test.ts`、
> `src/lib/providerModel.ts`、`src/components/providers/**`、`src/types.ts`）。**不要修改这些文件**，
> 也不要修改 `AppState.tsx` / `storage.ts` / `StudyView*` / `Dashboard*`（Lead 负责）。
> 类型检查时若报错来自这些文件，属于并发会话的在途改动，忽略即可。

## 0. 目标行为（验收口径）

- 学习页两个 tab：**学习**、**闪卡**。
- 一轮 = 新词 1 个（每词 4～8 题，默认 6）→ 复习 4～6 词（题量 `词数～2×词数`，默认 10）→ 小结 → 点「继续」下一轮。
- 新词先过闪卡闸门：**不认识 / 掌握**。点掌握则翻面显示释义，追问确认；确认即标掌握，永久不再学、不再复习。
- 不认识：直接出题，无独立教学卡；**第 1 题反馈附完整词条信息**。
- 闪卡 tab：已学词快速自查；点不认识则排下一轮复习优先；点掌握同「翻面 → 确认 → 掌握」。
- 掌握判定：连续 3 次全对 且 覆盖 ≥2 技能 且 14 天无错 且 分布 ≥2 轮次；可手动取消掌握。
- 取消间隔重复排程：复习每轮必做，按薄弱度选词。
- 6 题型 `en2zh`、`zh2en`、`spell`、`listen`、`sentence`、`translate`；全部本地生成、离线可用。
- 互译每题都调 LLM 判分（流式），三档 `perfect` / `good` / `poor`；`poor` 必须看完讲解才能下一题。
- 听音题用浏览器 TTS；无可用英文语音则不出听音题。未配置 AI 则不出互译题。
- 互译占轮次题量比例 ≤ 1/3。
- 答错：流式 AI 讲解（错因 + 记忆点 + 改进），不自动跳题；答对：本地鼓励语，3 秒后自动下一题（可设 0 = 手动）。
- 讲解写入作答记录；失败降级为本地解析，不阻塞作答。
- 薄弱分析：6 维度从作答记录现算；仪表盘展示各技能正确率、最弱词、建议重点；复习选词与题型按薄弱度优先。

## 1. 已由 Lead 落定的类型（`src/types.ts`）

```ts
// Attempt 新增
roundId?: string;

// 掌握标记
interface MasteryRecord { wordId: string; masteredAt: number; source: 'manual' | 'rule' }

// 单题结果（持久化在 PracticeSessionState.results）
interface PracticeResult {
  questionId: string; wordId: string; skill: Skill; exerciseType: ExerciseType;
  prompt: string; response: string; answer: string; correct: boolean;
  verdict?: TranslationVerdict; aiFeedback?: string; aiImprovement?: string;
  aiStatus?: 'ok' | 'failed' | 'local-fallback'; latencyMs?: number; answeredAt: number;
}

// 一轮练习状态（新字段全部可选，旧数据保持缺省）
interface PracticeSessionState {
  id: string; startedAt: number;
  stage: 'gate' | 'new' | 'review' | 'done';
  newWordIds: string[]; completedNewWordIds: string[]; reviewWordIds: string[];
  answered: number; targetQuestions: number;
  roundNo?: number;
  gate?: 'ask' | 'confirm' | null;
  currentWordId?: string;
  questions?: Exercise[];
  questionIndex?: number;
  results?: PracticeResult[];
}

// AppData 新增（可选，读取层会补 {}）
mastery?: Record<string, MasteryRecord>;
reviewPriority?: Record<string, number>;
```

作答记录的 `skill` / `verdict` / `aiFeedback` / `aiImprovement` / `aiStatus` / `latencyMs`
类型已在 Phase A 落好，直接使用。

## 2. `src/lib/practice.ts` —— 本地出题（6 技能）

```ts
import type { Exercise, ExerciseType, PracticeSettings, Skill, Word } from '../types';

export const SKILLS: Skill[];  // ['en2zh','zh2en','spell','listen','sentence','translate']

export interface SkillMeta {
  label: string;       // 「英译中」「中译英」「拼写」「听音」「例句」「互译」
  short: string;       // 「英→中」「中→英」等短标签
  type: ExerciseType;  // 生成的 ExerciseType
  description: string; // 一句话（仪表盘/设置页展示）
  needsTts: boolean;
  needsAI: boolean;
}
export const SKILL_META: Record<Skill, SkillMeta>;

export interface GenerateOptions {
  /** 全库词条（含目标词），用于生成干扰项。 */
  words: Word[];
  settings: PracticeSettings;
  /** 浏览器是否有可用英文语音（无 → 不生成 listen）。 */
  ttsAvailable: boolean;
  /** 是否配置了可用 LLM（无 → 不生成 translate）。 */
  aiAvailable: boolean;
  /** 随机源，默认 Math.random。 */
  rng?: () => number;
  /** 期望题量（尽量满足）。 */
  count: number;
  /** 指定技能顺序（薄弱优先）；缺省按均衡策略。 */
  skills?: Skill[];
  /** 是否为新词（第 1 题反馈附词条信息由 UI 处理，这里仅影响题量分配）。 */
  isNewWord?: boolean;
}

/** 为单个词生成 count 道题（含新词全部题型）。 */
export function buildQuestions(word: Word, options: GenerateOptions): Exercise[];
/** 为多个复习词生成 count 道题，尽量覆盖每个词（每词 ≥1 题）。 */
export function buildMixedQuestions(words: Word[], options: GenerateOptions): Exercise[];
/** 选出 count 道题实际可用的技能序列（按 skills 优先，均衡其余可用技能）。 */
export function pickSkills(options: Pick<GenerateOptions,
  'skills' | 'ttsAvailable' | 'aiAvailable' | 'rng'> & { count: number }): Skill[];
/** 本地判分：choice/句选词用 normalizeAnswer 严格匹配；拼写/填空容忍大小写、首尾标点与空格。 */
export function checkAnswer(exercise: Exercise, response: string): boolean;
export function isTranslation(exercise: Exercise): boolean;
export function skillLabel(skill?: Skill): string; // 缺省返回 '练习'
```

题目字段硬性要求（README/spec 落定）：

- `id = uid('ex')`、`wordId`、`skill` 与 `Exercise.type` 对应（见下表）、`source='local'`。
- `prompt ≤ 500`、`explanation ≤ 400`、`difficulty` 为 1~5 整数。解析用中文，给出记忆点。
- 选择题 `options` 3~4 个、去重、`answer` 严格等于其中某一项原文；干扰项优先同词性、排除与正确答案近义的释义；随机打乱。
- 填空/拼写 `answer` 非空，`acceptableAnswers` 可含合理变体。
- 每题只有一个正确答案；禁止「以上都对」。

| skill | type | 题目形态 | 答案 |
| --- | --- | --- | --- |
| `en2zh` | `choice` | 选 `term` 的正确中文释义 | 释义原文 |
| `zh2en` | `choice` | 选中文释义对应的英文单词 | 单词原文 |
| `spell` | `spell` | 看释义（含音标）写出英文单词 | 单词 |
| `listen` | `choice` | 听发音选释义，`audio=true`，prompt「听发音，选出正确的释义。」 | 释义原文 |
| `sentence` | `sentence` | 例句挖空选词（`____`），选项为单词 | 单词 |
| `translate` | `translate` | 互译自由作答；`direction` 为 `en2zh`/`zh2en`；`answer` 为参考译文 | 参考译文 |

生成规则：

- `listen` 仅在 `ttsAvailable === true` 时出现；`translate` 仅在 `aiAvailable === true` 时出现。
- `translate` 题量 ≤ `floor(count/3)`（轮次占比 ≤1/3）；`count < 3` 时为 0。
- `translate` 需要 `word.example` 与 `word.exampleTranslation` 同时存在，否则该技能不可用。
- `sentence` 需要 `word.example` 中出现目标词（不区分大小写；含屈折形式也可），否则该技能不可用。
- 技能不足时应回退到 `en2zh` / `zh2en` / `spell` 补齐题量；同一题内不得重复同一 `wordId+skill+prompt`。
- 复习题（`buildMixedQuestions`）先保证每个词至少 1 题，再按薄弱优先的技能轮转，总数不超过 `count`。
- 干扰项不足（词库小）时选项可为 3 个；词库只有 1~2 个词时允许 2 个选项，绝不抛错。

## 3. `src/lib/mastery.ts` —— 掌握判定

```ts
export const MASTERY_RULES: {
  consecutiveCorrect: 3; minSkills: 2; errorFreeDays: 14; minRounds: 2;
};

export interface MasteryCheck {
  eligible: boolean;
  /** 从最新作答往前数的连续答对次数（遇错即止；只统计带 skill 的练习作答）。 */
  streak: number;
  /** 该连续区间覆盖的技能与轮次。 */
  skills: Skill[];
  roundIds: string[];
  /** 距最近一次答错的天数；从未答错时 = 距首次练习作答的天数；无作答 = 0。 */
  errorFreeDays: number;
  /** 未满足的原因（中文，可空）。 */
  reasons: string[];
}

export function evaluateMastery(data: AppData, wordId: string, now?: number): MasteryCheck;
export function isMastered(data: AppData, wordId: string): boolean;
```

规则（严格按下表；全部满足才 `eligible`）：

1. 最近连续 **3** 次练习作答全对（从最新往前数，遇到错题即停）。
2. 这 3 次覆盖 **≥2** 个技能（`attempt.skill`）。
3. **14 天无错**：`now - 最近一次答错时间 ≥ 14 天`；从未答错时从**首次练习作答**算起。
4. 这 3 次分布在 **≥2** 个轮次（`attempt.roundId`；缺失 `roundId` 的旧作答合并为一个 `legacy` 轮次）。
5. 已被手动/规则标记掌握（`data.mastery[wordId]` 存在）时 `eligible === true`。

## 4. `src/lib/weakness.ts` —— 薄弱分析（6 维度）

```ts
export interface SkillStat {
  skill: Skill; label: string;
  attempts: number; correct: number;
  accuracy: number | null;      // 百分整数；无作答为 null
  lastAt?: number;
}
export interface WeakWordStat {
  word: Word; attempts: number; accuracy: number | null;
  wrongCount: number; lastAt?: number;
}
export interface WeaknessReport {
  skills: SkillStat[];            // 固定 6 项，顺序同 SKILLS
  practiced: boolean;             // 是否已有带 skill 的作答
  weakestSkill: Skill | null;
  weakestWords: WeakWordStat[];   // 默认 ≤5，按薄弱度降序
  /** 建议重点（一句中文）：如「听音与互译最弱，先做 3 道听音题」。 */
  focus: string;
}

export function getSkillStats(data: AppData, now?: number): SkillStat[];
export function getWeaknessReport(
  data: AppData,
  options?: { limit?: number; now?: number },
): WeaknessReport;
/** 单词语弱度，分越高越该复习（用于复习选词排序；掌握词/新词不参与）。 */
export function scoreWordWeakness(data: AppData, wordId: string, now?: number): number;
```

口径：只统计 `kind === 'exercise'` 且带 `skill` 的作答（互译用 `correct`）；薄弱度 = 错误次数 × 高权重 +
近期正确率低 + 最近作答久未复习 + 闪卡「不认识」优先级（`data.reviewPriority` 由 Lead 在排序时处理，
本模块只需在 `scoreWordWeakness` 里给 `reviewPriority` 额外加权）。

## 5. `src/lib/rounds.ts` —— 一轮选词与题量

```ts
export interface RoundPlan {
  id: string;                  // uid('round')
  roundNo: number;             // 第几轮（从 1 起）
  newWord: Word | null;        // 本轮新词（每轮 1 个；没有新词时为 null）
  reviewWords: Word[];         // 复习词（4~6，按薄弱度）
}

export function countAvailable(data: AppData, now?: number): {
  newWords: number; reviewWords: number; mastered: number;
};
export function pickNewWord(data: AppData, now?: number): Word | null;
export function pickReviewWords(
  data: AppData,
  limit: number,
  options?: { now?: number; excludeWordIds?: string[] },
): Word[];
export function planRound(
  data: AppData,
  settings: PracticeSettings,
  options?: { now?: number; excludeWordIds?: string[] },
): RoundPlan;
export function scoreReviewWord(data: AppData, word: Word, now?: number): number;
```

规则：

- 复习候选 = 已学（`srs` 状态非 `new`）、未掌握（无 `mastery` 记录且 `status !== 'mastered'`）的词。
- 排序：`data.reviewPriority` 中标记的词最优先（值 = 标记时间，越早标记越优先），其后按
  `scoreReviewWord` 降序（薄弱优先），同分按最近作答久远优先。
- 掌握词、新词永不出现在复习列表；`excludeWordIds` 里的词排除（本轮新词不重复复习）。
- 「已学」判定兜底：卡片状态为 `new` 但 `reps > 0` 且 `lastReviewedAt` 不晚于当前时间的，也算已学（脏数据兜底，
  避免闪卡刚建卡就自评过的词被重新当成新词学习）。
- 复习词数 = `clamp(settings.reviewWordsPerRound, 4, 6)`；不足时按实际数量。
- 复习题量 = `clamp(settings.reviewQuestionsPerRound, 词数, 2×词数)`；由 UI 传给 `buildMixedQuestions`。
- `roundNo` = 当前 `data.session?.roundNo` 基础上 +1；无 session 时为 1。

## 6. `src/lib/tts.ts` —— 浏览器 TTS

```ts
export interface TtsVoice { voiceUri: string; name: string; lang: string; }

export function isSpeechSupported(): boolean;
export function listEnglishVoices(): TtsVoice[];   // lang 以 en 开头
export function hasEnglishVoice(): boolean;
export function pickEnglishVoice(preferredUri?: string): TtsVoice | null;
/** 朗读英文（不抛错；返回是否成功发出）。 */
export function speak(text: string, options?: { rate?: number; voiceUri?: string }): boolean;
export function cancelSpeech(): void;
/** React Hook：返回当前可用英文语音列表，监听 voiceschanged。 */
export function useEnglishVoices(): TtsVoice[];
```

- 所有函数在 `typeof window === 'undefined'` 或无 `speechSynthesis` 时安全降级（返回空/false）。
- `useEnglishVoices` 可用 React 的 `useEffect` / `useState`（文件为 `.ts`，无 JSX）。

## 7. `src/lib/feedback.ts` + `src/lib/llm/feedbackPrompts.ts` —— AI 讲解与互译判分

```ts
// feedbackPrompts.ts
export const FEEDBACK_PROMPT_VERSION = 'v1';
export function buildAnswerFeedbackMessages(input: AnswerFeedbackInput): ChatMessage[];
export function buildTranslationMessages(input: TranslateGradeInput): ChatMessage[];

// feedback.ts
import type { ChatMessage } from './llm/types'; // 只 import 类型
export type FeedbackStatus = 'ok' | 'failed' | 'local-fallback';

export interface AnswerFeedbackInput {
  word: Word; exercise: Exercise; response: string;
}
export interface AnswerFeedback {
  /** 完整讲解文本：错因 + 记忆点 + 改进（≤400 截断前）。 */
  explanation: string;
  improvement?: string;
  status: FeedbackStatus;
}
export function localAnswerFeedback(input: AnswerFeedbackInput): AnswerFeedback;
export function parseFeedbackImprovement(text: string): string | undefined;
export async function streamAnswerFeedback(
  input: AnswerFeedbackInput,
  settings: LLMSettings,
  options?: { signal?: AbortSignal; onToken?: (chunk: string) => void; timeoutMs?: number },
): Promise<AnswerFeedback>;   // 失败 → status='local-fallback' + localAnswerFeedback，永不抛错

export interface TranslateGradeInput {
  word: Word; exercise: Exercise; response: string;
}
export interface TranslationGrade {
  verdict: TranslationVerdict;   // perfect | good | poor
  explanation: string;
  improvement?: string;
  status: FeedbackStatus;
}
export function localTranslationGrade(input: TranslateGradeInput): TranslationGrade;
export function parseTranslationVerdict(text: string): TranslationVerdict | null;
export async function streamTranslationGrade(
  input: TranslateGradeInput,
  settings: LLMSettings,
  options?: {
    signal?: AbortSignal;
    onToken?: (chunk: string) => void;    // 只回传讲解正文（不含 VERDICT 行）
    onVerdict?: (verdict: TranslationVerdict) => void;
    timeoutMs?: number;
  },
): Promise<TranslationGrade>;            // 失败 → localTranslationGrade
export function encouragement(seed?: number): string;  // 本地鼓励语（可随机）
```

- 用 `streamChat`（`./llm/providers`）做流式；`settings` 由调用方用
  `resolveActiveLLMSettings(data)` 派生（Lead/UI 负责）。
- 互译输出格式：第一行 `VERDICT: perfect|good|poor`，空行后讲解正文（改进建议）。流式过程中
  解析出 verdict 后立刻 `onVerdict`，`onToken` 只回调讲解正文。
- 答错讲解输出三段：`错因：…` / `记忆点：…` / `改进：…`；`parseFeedbackImprovement` 提取「改进」。
- 所有失败（未配置 / 网络 / 超时 / 取消）必须降级为本地解析，不阻塞作答；`status='local-fallback'`。
- 提示词中文、判分严格：perfect = 意思完整准确且表达自然；good = 意思基本正确、有小瑕疵；
  poor = 关键信息错误/遗漏或无法理解。
- `EXPLANATION_MAX = 400`（存储截断；流式可见全文）。

## 8. UI 契约（Lead 实现的 StudyView 会调用上述模块）

- 答题顺序状态机由 Lead 的 `src/lib/practiceRound.ts` 驱动，持久化到 `data.session`（退出可恢复）。
- 第 1 题反馈附词条信息：由 UI 在 `session.stage==='new' && session.questionIndex===0` 时渲染
  `word.term / phonetic / partOfSpeech / meaning / example / exampleTranslation / tags`。
- 答错：调用 `streamAnswerFeedback`；答对：`encouragement` + `feedbackAutoAdvanceMs` 自动下一题。
- **作答阶段 `AnswerPhase`**（`components/study/types.ts`）：`idle` 未答 / `judging` 判分中 /
  `retry` 答错但**不锁题** / `answered` 已答对。`isAnswering(phase)` 是「还能不能继续作答」的**唯一**判断，
  **不要**再另加需要外部解锁的「提交锁」：第二次答错时 `phase` 前后都是 `retry`（`judging` 被批处理吞掉），
  靠「phase 变化才解锁」的标志位会永远解不开，题目就此点不动。长按按键的 `event.repeat` 在 keydown 里挡掉。
  答错后输入框与选项立即可继续操作（AI 讲解仍在流式输出也不挡），可一直答到对为止；
  答错时右栏给「跳过这题」，答对后才是「下一题」。
- **选择题选项状态**（`components/study/optionState.ts`）：`idle` / `selected` / `correct` / `wrong`，
  由 `resolveOptionStates` 统一算出，组件只做样式映射。规则：任何一次新作答都会清掉上一轮的强调，
  界面永远只强调「刚选的那一项」（答错不提前标出正解）。动效 / 声效订阅 `emitOptionFeedback`
  （`pick` 与 `verdict` 两个时机），DOM 上同步输出 `data-option-state`。
- **同一道题只记录第一次作答**：答错后的重试不再 `applyAnswer` / `recordExercise`，
  否则会虚高正确率并让 `isRoundComplete` 提前判定整轮答完。
- 互译：`streamTranslationGrade`；`poor` 时「下一题」按钮在流式结束且用户点「我看完了」后才可用。
- 每次判分：`actions.recordExercise({... skill, latencyMs, verdict, roundId, aiFeedback, aiImprovement, aiStatus })`
  并 `actions.setPracticeSession(...)` 写回本轮状态；规则满足时 reducer 自动标记掌握。
- **题目推进是显式的**：`practiceRound.applyAnswer` 只记录作答与讲解，**不推进 `questionIndex`**；
  用户确认反馈（「继续」）后必须再调 `practiceRound.advanceQuestion(session)`，否则会停在原题。
- 同词同技能在一轮内不重复；新词题量默认 6 时会覆盖 en2zh / zh2en / spell / listen / sentence / translate 六类。
- 流式反馈的增量文本已做 Key 脱敏（跨 chunk 也会挡住），UI 可直接渲染 `onToken`。
- 判分有效技能覆盖：选择/拼写/听音/例句 = 本地判定；互译 = LLM 判定（降级本地）。

## 9. 验收与约束

- **不写测试、不运行测试**（用户明确要求；`pnpm test` 由 Lead 端最终不执行）。
- 只写自己范围内文件；完成后用 `pnpm exec tsc --noEmit` 检查**自己新增文件**的类型错误
  （并发会话可能让全量 typecheck 出现无关报错，忽略不属于自己文件的报错）。
- 完成后向 Lead 回报：改动文件清单、导出的 API、未实现/降级的行为（若有）。
