import type { AnswerPhase } from './types';

export type OptionState = 'idle' | 'selected' | 'correct' | 'wrong';

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
  options: readonly string[];
  picked: string | null;
  answer: string;
  phase: AnswerPhase;
}

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
      return hasPicked && option === picked ? 'wrong' : 'idle';
    }
    if (phase === 'answered') {
      return option === answer ? 'correct' : 'idle';
    }
    return hasPicked && option === picked ? 'selected' : 'idle';
  });
}

export type OptionFeedbackStage = 'pick' | 'verdict';

export interface OptionFeedbackEvent {
  stage: OptionFeedbackStage;
  index: number;
  state: OptionState;
  option: string;
  questionId: string;
}

type OptionFeedbackListener = (event: OptionFeedbackEvent) => void;

const listeners = new Set<OptionFeedbackListener>();

export function onOptionFeedback(listener: OptionFeedbackListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitOptionFeedback(event: OptionFeedbackEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // ignore
    }
  }
}
