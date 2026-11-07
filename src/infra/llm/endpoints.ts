/**
 * LLM 上游 URL 解析（纯函数，可单测）。
 */

import type { LLMSettings } from '@/domain/types';
import { LLMError } from './types';

/** 去掉首尾空白与末尾斜杠。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function hasNonRootPath(baseUrl: string): boolean {
  const withoutOrigin = normalizeBaseUrl(baseUrl).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  return withoutOrigin.length > 0;
}

/** 取 `scheme://host[:port]` 形式的 origin；非法 URL 返回 null。 */
export function extractOrigin(baseUrl: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(normalizeBaseUrl(baseUrl));
  return match ? match[1] : null;
}

function endsWithApiVersion(baseUrl: string): boolean {
  return /\/v\d+(?:[a-z]+\d*)?$/i.test(normalizeBaseUrl(baseUrl));
}

/** 是否为 Anthropic 官方主机。 */
export function isOfficialAnthropicHost(baseUrl: string): boolean {
  const origin = extractOrigin(baseUrl);
  if (!origin) return false;
  const host = origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/:\d+$/, '').toLowerCase();
  return host === 'api.anthropic.com';
}

export function resolveEndpoint(settings: Pick<LLMSettings, 'provider' | 'baseUrl'>): string {
  const base = normalizeBaseUrl(settings.baseUrl);
  if (!base) {
    throw new LLMError('config', '尚未填写 Base URL，请到设置页补全（例如 https://api.deepseek.com/v1）。');
  }

  if (settings.provider === 'anthropic') {
    if (/\/messages$/i.test(base)) return base;
    if (endsWithApiVersion(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }

  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  if (!hasNonRootPath(base)) return `${base}/v1/chat/completions`;
  return `${base}/chat/completions`;
}

export function resolveModelsEndpoint(settings: Pick<LLMSettings, 'provider' | 'baseUrl'>): string {
  const base = normalizeBaseUrl(settings.baseUrl);
  if (!base) {
    throw new LLMError('config', '尚未填写 Base URL，请到设置页补全。');
  }

  if (settings.provider === 'anthropic') {
    if (/\/models$/i.test(base)) return base;
    if (endsWithApiVersion(base)) return `${base}/models`;
    return `${base}/v1/models`;
  }

  const normalized = base.replace(/\/chat\/completions$/i, '');
  if (/\/models$/i.test(normalized)) return normalized;
  if (/\/v1$/i.test(normalized)) return `${normalized}/models`;
  if (!hasNonRootPath(normalized)) return `${normalized}/v1/models`;
  return `${normalized}/models`;
}

/** Ollama 原生模型列表：`{origin}/api/tags`。 */
export function resolveOllamaTagsEndpoint(baseUrl: string): string | null {
  const origin = extractOrigin(baseUrl);
  return origin ? `${origin}/api/tags` : null;
}
