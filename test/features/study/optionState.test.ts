import { describe, expect, it, vi } from 'vitest';
import {
  emitOptionFeedback,
  onOptionFeedback,
  optionStateClass,
  resolveOptionStates,
} from '@/features/study/optionState';

const OPTIONS = ['面对；对抗', '恶化；变坏', '预料；预期', '波动；起伏'];
const ANSWER = '波动；起伏';

describe('resolveOptionStates', () => {
  it('未作答时全部为 idle', () => {
    expect(
      resolveOptionStates({ options: OPTIONS, picked: null, answer: ANSWER, phase: 'idle' }),
    ).toEqual(['idle', 'idle', 'idle', 'idle']);
  });

  it('判分中只强调本次选中的那一项，不泄漏答案', () => {
    expect(
      resolveOptionStates({ options: OPTIONS, picked: OPTIONS[0], answer: ANSWER, phase: 'judging' }),
    ).toEqual(['selected', 'idle', 'idle', 'idle']);
  });

  it('答错时只标红自己选的那一项，正解保持常态（不提前给答案）', () => {
    expect(
      resolveOptionStates({ options: OPTIONS, picked: OPTIONS[0], answer: ANSWER, phase: 'retry' }),
    ).toEqual(['wrong', 'idle', 'idle', 'idle']);
  });

  it('答对时只强调正解', () => {
    expect(
      resolveOptionStates({ options: OPTIONS, picked: ANSWER, answer: ANSWER, phase: 'answered' }),
    ).toEqual(['idle', 'idle', 'idle', 'correct']);
  });

  it('重新作答会清掉上一轮的强调，只剩新选中的那一项', () => {
    const picked = OPTIONS[1];
    const states = resolveOptionStates({ options: OPTIONS, picked, answer: ANSWER, phase: 'judging' });
    expect(states[0]).toBe('idle');
    expect(states[1]).toBe('selected');
    expect(states.filter((state) => state !== 'idle')).toHaveLength(1);
  });

  it('脏数据安全降级为空数组', () => {
    expect(
      resolveOptionStates({
        options: undefined as unknown as string[],
        picked: null,
        answer: '',
        phase: 'idle',
      }),
    ).toEqual([]);
    expect(
      resolveOptionStates({ options: [], picked: 'x', answer: 'x', phase: 'answered' }),
    ).toEqual([]);
  });
});

describe('optionStateClass', () => {
  it('状态映射到唯一的样式类名', () => {
    expect(optionStateClass('idle')).toBeNull();
    expect(optionStateClass('selected')).toBe('is-selected');
    expect(optionStateClass('correct')).toBe('is-correct');
    expect(optionStateClass('wrong')).toBe('is-wrong');
  });
});

describe('option feedback 订阅', () => {
  it('订阅者收到 pick / verdict 事件，退订后不再收到', () => {
    const listener = vi.fn();
    const off = onOptionFeedback(listener);

    emitOptionFeedback({
      stage: 'pick',
      index: 1,
      state: 'selected',
      option: OPTIONS[1],
      questionId: 'q1',
    });
    emitOptionFeedback({
      stage: 'verdict',
      index: 1,
      state: 'wrong',
      option: OPTIONS[1],
      questionId: 'q1',
    });
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    emitOptionFeedback({
      stage: 'pick',
      index: 2,
      state: 'selected',
      option: OPTIONS[2],
      questionId: 'q1',
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
