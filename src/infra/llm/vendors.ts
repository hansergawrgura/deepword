/**
 * 各厂商「思考/推理」参数白名单映射。
 */

import type { LLMSettings } from '@/domain/types';

/** 上游可能拒绝的「关闭思考」参数名，用于 400 去参重试。 */
export const THINKING_PARAM_KEYS = ['thinking', 'reasoning_effort', 'enable_thinking'] as const;

const KIMI_K3_PATTERN = /(^|[^a-z0-9])k3([^a-z0-9]|$)/i;

export function buildThinkingParams(settings: LLMSettings): Record<string, unknown> {
  switch (settings.vendor) {
    case 'anthropic':
    case 'deepseek':
    case 'glm':
    case 'volcengine':
      return { thinking: { type: 'disabled' } };
    case 'qwen':
    case 'siliconflow':
      return { enable_thinking: false };
    case 'openai':
      return { reasoning_effort: 'minimal' };
    case 'ollama':
      return { reasoning_effort: 'none' };
    case 'kimi':
      return KIMI_K3_PATTERN.test(settings.model.trim())
        ? { reasoning_effort: 'low' }
        : { thinking: { type: 'disabled' } };
    default:
      return {};
  }
}

function shouldInjectThinking(settings: LLMSettings, noThink?: boolean): boolean {
  return noThink === true || settings.thinkingMode === 'off';
}

export function applyThinkingParams(
  body: Record<string, unknown>,
  settings: LLMSettings,
  noThink?: boolean,
): Record<string, unknown> {
  if (!shouldInjectThinking(settings, noThink)) return body;
  const params = buildThinkingParams(settings);
  if (Object.keys(params).length === 0) return body;
  return { ...body, ...params };
}

export function hasThinkingParams(body: Record<string, unknown>): boolean {
  return THINKING_PARAM_KEYS.some((key) => body[key] !== undefined);
}

export function removeThinkingParams(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  for (const key of THINKING_PARAM_KEYS) delete next[key];
  return next;
}

export function mentionsThinkingParam(text: string): boolean {
  return /thinking|reasoning_effort|enable_thinking/i.test(text);
}

export function mentionsStreamParam(text: string): boolean {
  return /stream/i.test(text);
}
