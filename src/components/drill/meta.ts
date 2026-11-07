/** 错题特训页的展示元信息、文案与纯函数工具。 */

import type { LLMError } from '@/lib/llm';
import type {
  DifficultyPreference,
  ExerciseSource,
  ExerciseType,
  LLMSettings,
} from '@/types';
import { truncate } from '@/lib/utils';

export const COUNT_OPTIONS = [4, 6, 8] as const;

export const OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const;

export const EXERCISE_TYPE_META: Record<ExerciseType, { label: string; short: string }> = {
  choice: { label: '词义选择', short: '词义' },
  fill: { label: '例句填空', short: '填空' },
  usage: { label: '用法辨析', short: '用法' },
  correction: { label: '句子改错', short: '改错' },
};

export const DIFFICULTY_OPTIONS: Array<{
  value: DifficultyPreference;
  label: string;
  description: string;
}> = [
  {
    value: 'adaptive',
    label: '自适应',
    description: '按错词历史与近期正确率自动配题，错得多的词多练一点。',
  },
  {
    value: 'foundation',
    label: '巩固基础',
    description: '围绕词义与拼写打底，先把基本盘稳住。',
  },
  {
    value: 'challenge',
    label: '挑战',
    description: '偏语境运用与近义辨析，往难处再走一阶。',
  },
];

export const DIFFICULTY_LABEL: Record<DifficultyPreference, string> = {
  adaptive: '自适应',
  foundation: '巩固基础',
  challenge: '挑战',
};

export const SOURCE_LABEL: Record<ExerciseSource, string> = {
  llm: '大模型命题',
  local: '本地题库',
};

/** 组卷失败时按错误码给出的可操作建议（尽量给出下一步，而不是重复错误信息）。 */
const LLM_ERROR_HINTS: Record<LLMError['code'], string> = {
  config: '到设置里补全 Base URL 与模型名后再试。',
  network: '若走代理，请确认地址能从浏览器直接访问；也可以先用本地题库。',
  auth: '到设置里更新 API Key 后再试，或先用本地题库。',
  'rate-limit': '稍等片刻再试，或先用本地题库。',
  timeout: '可以重试一次，或先用本地题库。',
  http: '检查 Base URL 与模型名是否匹配，也可先用本地题库。',
  parse: '重试一次通常就好；也可以用本地题库。',
  empty: '可以重试，或改用本地题库。',
  aborted: '这次命题已取消。',
  server: '稍后重试，或先用本地题库。',
};

export function llmErrorHint(code: LLMError['code']): string {
  return LLM_ERROR_HINTS[code] ?? '可以重试一次，或改用本地题库继续。';
}

export function providerLabel(settings: LLMSettings): string {
  return settings.provider === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容';
}

/** 粗略判断接口是否为远端地址（缺 Key 时提示；localhost / Ollama 不提示）。 */
export function isRemoteEndpoint(baseUrl: string): boolean {
  const value = baseUrl.trim().toLowerCase();
  if (!/^https?:\/\//.test(value)) return false;
  return !/(^https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)/.test(
    value,
  );
}

/** 本卷题目来源的简短摘要。 */
export function sourceSummary(sources: ExerciseSource[]): string {
  const hasLlm = sources.includes('llm');
  const hasLocal = sources.includes('local');
  if (hasLlm && hasLocal) return '混合命题';
  if (hasLlm) return '大模型命题';
  return '本地题库';
}

/** 用时：不足一分钟只说秒，超过一分钟说「X 分 YY 秒」。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total <= 0) return '不到 1 秒';
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
}

/** 结果页的「批语」：按正确率给一句编辑口吻的点评；提前结束时如实说明。 */
export function batchComment(
  accuracy: number,
  wrongCount: number,
  answeredCount: number,
  totalQuestions: number,
): string {
  if (answeredCount < totalQuestions) {
    return wrongCount === 0
      ? '已答的几题全中；这卷还没答完，完整练一组再看章法。'
      : '这卷还没答完，错处先记下；下次完整练一组，才看得出章法。';
  }
  if (wrongCount === 0) return '满卷无错，笔笔落定。去闪卡里把它们再读一遍。';
  if (accuracy >= 85) return '笔意沉稳，只是偶有失手。错处看一眼，便又牢一分。';
  if (accuracy >= 60) return '大意已通，细处还有漏笔。把下面的错题逐条读透。';
  if (accuracy >= 30) return '错处正是门径。比全对更值得的，是知道自己错在哪。';
  return '这一卷错得多，不必急。先把错词读一遍，再组一组新的。';
}

/** 错误详情可能很长，展示前截断。 */
export function shortDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  return truncate(detail.trim(), 260);
}
