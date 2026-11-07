/**
 * 选择题「选项状态」的唯一来源。
 *
 * 所有走选项作答的题型（英译中 / 中译英 / 听音 / 例句填空）都通过这里算出
 * 每个选项此刻的状态，组件只负责把状态映射成样式，不再各自判断「谁高亮」。
 *
 * 状态机（与 AnswerPhase 一一对应）：
 *
 *   idle / judging   →  picked ? 'selected' : 'idle'     只强调本次选中的那一项
 *   retry（答错）     →  picked ? 'wrong'    : 'idle'     仍然只强调自己选的那一项
 *   answered（答对）  →  answer ? 'correct'  : 'idle'     只强调答对的那一项
 *
 * 三条规则合起来保证：**任何一次新的作答都会清掉上一轮的强调**，界面上永远
 * 只有「我刚选的那一项」被强调，不会出现红色错选和绿色正解同时亮着。
 *
 * 需要做动效 / 声效时，统一订阅 emitOptionFeedback（见文件末尾），
 * 不需要改任何题目组件。
 */

import type { AnswerPhase } from './types';

/** 单个选项的状态。 */
export type OptionState = 'idle' | 'selected' | 'correct' | 'wrong';

/** 状态 → 样式类名（唯一映射，改样式只改这里）。 */
const OPTION_STATE_CLASS: Record<OptionState, string | null> = {
  idle: null,
  selected: 'is-selected',
  correct: 'is-correct',
  wrong: 'is-wrong',
};

export function optionStateClass(state: OptionState): string | null {
  return OPTION_STATE_CLASS[state];
}

export interface OptionStateInput {
  /** 本题全部选项（顺序即展示顺序）。 */
  options: readonly string[];
  /** 本次选中的选项原文；null = 尚未作答。 */
  picked: string | null;
  /** 正确答案原文。 */
  answer: string;
  phase: AnswerPhase;
}

/**
 * 算出每个选项的状态。纯函数、不抛错：脏数据（非数组、空答案）安全降级为全 idle。
 */
export function resolveOptionStates({
  options,
  picked,
  answer,
  phase,
}: OptionStateInput): OptionState[] {
  if (!Array.isArray(options) || options.length === 0) return [];
  const hasPicked = typeof picked === 'string' && picked.length > 0;

  return options.map((option) => {
    if (phase === 'retry') {
      // 答错：只把「我刚选的那项」标红，正解和其他干扰项一律回到常态。
      return hasPicked && option === picked ? 'wrong' : 'idle';
    }
    if (phase === 'answered') {
      // 答对：只强调正解（正常流程里它就是刚选中的那项）。
      return option === answer ? 'correct' : 'idle';
    }
    // idle / judging：选项被按下即提交，'selected' 是判分落地前的那一帧。
    return hasPicked && option === picked ? 'selected' : 'idle';
  });
}

/* ------------------------------------------------------------------ */
/* 反馈出口：动效 / 声效的统一挂载点                                    */
/* ------------------------------------------------------------------ */

/**
 * 一次选项反馈的时机：
 * - pick    用户按下选项（等价键盘 A/B/C/D），判分尚未落地；
 * - verdict 判分落地（correct / wrong）。
 */
export type OptionFeedbackStage = 'pick' | 'verdict';

export interface OptionFeedbackEvent {
  stage: OptionFeedbackStage;
  /** 选项序号（0 基），用于做「第几个」的声效 / 动画差异。 */
  index: number;
  /** 该选项此刻的状态。 */
  state: OptionState;
  /** 选项文本。 */
  option: string;
  /** 题目 id，便于埋点或按题去重。 */
  questionId: string;
}

type OptionFeedbackListener = (event: OptionFeedbackEvent) => void;

const listeners = new Set<OptionFeedbackListener>();

/**
 * 订阅选项反馈。返回取消订阅函数。
 * 未来的动效 / 声效只需在这里注册一次，所有选择题自动生效。
 */
export function onOptionFeedback(listener: OptionFeedbackListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 发出一次选项反馈；单个订阅者抛错不影响作答流程。 */
export function emitOptionFeedback(event: OptionFeedbackEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // 动效 / 声效失败不能影响答题。
    }
  }
}
