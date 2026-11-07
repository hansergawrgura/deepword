/** 错题特训页内部使用的本地视图类型（不进入全局领域模型）。 */

import type { Exercise } from '@/types';

/** 特训页的五个阶段：选词 → 组卷 → 失败 → 作答 → 复盘。 */
export type DrillStage = 'setup' | 'generating' | 'error' | 'quiz' | 'result';

/** 本卷的命题来源：大模型 / 本地题库。 */
export type DrillMode = 'llm' | 'local';

/** 一道题的一次作答记录，用于结果页复盘。 */
export interface AnswerRecord {
  exercise: Exercise;
  /** 用户实际给出的答案（选择题为选项原文，填空为输入内容）。 */
  response: string;
  correct: boolean;
}

/** 组卷失败时展示的可读错误信息。 */
export interface DrillErrorInfo {
  /** 这一次尝试使用的方式，决定「重试」按钮重试什么。 */
  mode: DrillMode;
  message: string;
  hint: string;
  detail?: string;
}
