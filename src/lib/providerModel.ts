/**
 * Provider 配置层：保存的多份配置、当前生效配置、厂商推断、导入时的 Key 继承。
 *
 * 纯函数、无 IO；设置页与状态层都从这里取口径，避免各处复制粘贴规则。
 */

import {
  DEFAULT_PRACTICE_SETTINGS,
  MAX_PROVIDERS,
  type AppData,
  type LegacyLLMSettings,
  type LLMSettings,
  type ProviderKind,
  type ProviderProfile,
  type Vendor,
} from '../types';
import { clamp, uid } from './utils';

/* ------------------------------------------------------------------ */
/* 厂商                                                                */
/* ------------------------------------------------------------------ */

export const VENDOR_OPTIONS: ReadonlyArray<{ value: Vendor; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: '通义千问 / DashScope' },
  { value: 'ollama', label: 'Ollama 本地' },
  { value: 'kimi', label: 'Kimi / Moonshot' },
  { value: 'glm', label: '智谱 GLM' },
  { value: 'siliconflow', label: '硅基流动' },
  { value: 'volcengine', label: '火山方舟 / Ark' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'custom', label: '其他 / 自定义' },
];

/** 厂商预填：只用于「填入预设」按钮，不强制。 */
export const VENDOR_PRESETS: Record<
  Vendor,
  { protocol: ProviderKind; baseUrl: string; model: string; hint: string }
> = {
  openai: {
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: 'OpenAI 官方接口',
  },
  anthropic: {
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    hint: 'Anthropic Messages API',
  },
  deepseek: {
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: 'DeepSeek；思考默认开启，可在此关闭',
  },
  qwen: {
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    hint: 'DashScope 兼容模式',
  },
  ollama: {
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    hint: '本地 Ollama，可不填 Key',
  },
  kimi: {
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    hint: 'Kimi / Moonshot',
  },
  glm: {
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    hint: '智谱 GLM',
  },
  siliconflow: {
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    hint: '硅基流动',
  },
  volcengine: {
    protocol: 'anthropic',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    model: 'deepseek-v4.1-flash',
    hint: '火山方舟 Ark（Anthropic 兼容）；Coding 计划 Base URL 填 /api/coding，模型以套餐列表为准',
  },
  minimax: {
    protocol: 'openai',
    baseUrl: 'https://api.minimax.chat/v1',
    model: 'MiniMax-Text-01',
    hint: 'MiniMax',
  },
  custom: {
    protocol: 'openai',
    baseUrl: '',
    model: '',
    hint: '任意 OpenAI 兼容 / Anthropic 兼容服务',
  },
};

export function vendorLabel(vendor: Vendor): string {
  return VENDOR_OPTIONS.find((item) => item.value === vendor)?.label ?? '其他';
}

/** 由 Base URL 推断厂商；推断不出来时按协议给默认值。 */
export function inferVendorFromBaseUrl(baseUrl: string, protocol: ProviderKind): Vendor {
  const value = baseUrl.trim().toLowerCase();
  if (!value) return protocol === 'anthropic' ? 'anthropic' : 'custom';
  if (value.includes('api.openai.com') || value.includes('api.openai.com/')) return 'openai';
  if (value.includes('api.anthropic.com')) return 'anthropic';
  if (value.includes('api.deepseek.com')) return 'deepseek';
  if (value.includes('dashscope')) return 'qwen';
  if (value.includes('localhost:11434') || value.includes('127.0.0.1:11434') || value.includes('ollama'))
    return 'ollama';
  if (value.includes('moonshot') || value.includes('kimi')) return 'kimi';
  if (value.includes('bigmodel.cn') || value.includes('zhipu')) return 'glm';
  if (value.includes('siliconflow')) return 'siliconflow';
  if (value.includes('minimax')) return 'minimax';
  // 火山方舟的 Anthropic 兼容端点放在 /api/coding；其 OpenAI 兼容端点（/api/v3）
  // 的思考参数未验证，因此只在 Anthropic 协议下推断为 volcengine，避免误注入参数。
  if (value.includes('ark.cn-beijing.volces.com')) {
    return protocol === 'anthropic' ? 'volcengine' : 'custom';
  }
  return protocol === 'anthropic' ? 'anthropic' : 'custom';
}

/* ------------------------------------------------------------------ */
/* 派生：profile → LLMSettings                                          */
/* ------------------------------------------------------------------ */

export function toLLMSettings(profile: ProviderProfile): LLMSettings {
  return {
    provider: profile.protocol,
    vendor: profile.vendor,
    thinkingMode: profile.thinkingMode,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.defaultModel,
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
  };
}

export function findActiveProvider(data: AppData): ProviderProfile | null {
  if (!data.activeProviderId) return null;
  return data.providers.find((item) => item.id === data.activeProviderId) ?? null;
}

/** 当前生效配置；没有可用配置时返回 null。 */
export function resolveActiveLLMSettings(data: AppData): LLMSettings | null {
  const profile = findActiveProvider(data);
  return profile ? toLLMSettings(profile) : null;
}

/** 设置页/关于页展示用：厂商 + 模型。 */
export function providerSummaryText(profile: ProviderProfile): string {
  const model = profile.defaultModel.trim() || '未填模型';
  return `${vendorLabel(profile.vendor)} · ${model}`;
}

/* ------------------------------------------------------------------ */
/* 校验与构造                                                           */
/* ------------------------------------------------------------------ */

export interface UrlCheck {
  ok: boolean;
  message?: string;
}

/** Base URL 必须是 http(s) 且能解析出主机。 */
export function checkBaseUrl(baseUrl: string): UrlCheck {
  const value = baseUrl.trim();
  if (!value) return { ok: false, message: '请填写 Base URL，例如 https://api.deepseek.com/v1。' };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: 'Base URL 不是合法网址。' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: 'Base URL 只支持 http:// 或 https://。' };
  }
  if (!parsed.hostname) return { ok: false, message: 'Base URL 缺少主机名。' };
  return { ok: true };
}

export function providerName(profile: ProviderProfile, index: number): string {
  return profile.name.trim() || `配置 ${index + 1}`;
}

/** 迁移 v1 的单份 settings → 一份 profile。 */
export function legacySettingsToProfile(settings: LegacyLLMSettings, now = Date.now()): ProviderProfile {
  const protocol: ProviderKind = settings.provider === 'anthropic' ? 'anthropic' : 'openai';
  const baseUrl = settings.baseUrl.trim();
  const model = settings.model.trim();
  return {
    id: uid('p'),
    name: '默认配置',
    protocol,
    vendor: inferVendorFromBaseUrl(baseUrl, protocol),
    baseUrl,
    apiKey: typeof settings.apiKey === 'string' ? settings.apiKey : '',
    models: model ? [model] : [],
    defaultModel: model,
    temperature: clamp(Number(settings.temperature) || 0.7, 0, 2),
    maxTokens: Math.round(clamp(Number(settings.maxTokens) || 2_500, 64, 32_000)),
    thinkingMode: 'off',
    createdAt: now,
    updatedAt: now,
  };
}

export function createInitialProviders(now = Date.now()): ProviderProfile[] {
  return [legacySettingsToProfile({ ...DEFAULT_LEGACY_SETTINGS }, now)];
}

export const DEFAULT_LEGACY_SETTINGS: LegacyLLMSettings = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 2_500,
};

/* ------------------------------------------------------------------ */
/* 导入备份：保留本机 Key                                               */
/* ------------------------------------------------------------------ */

function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * 导入备份时，备份里的 provider 若没有 Key，则按 Base URL 从本机现有配置继承；
 * 备份带了非空 Key 时以备份为准。
 */
export function preserveApiKeys(
  imported: ProviderProfile[],
  current: ProviderProfile[],
): ProviderProfile[] {
  if (imported.length === 0) return imported;
  const byBase = new Map(current.map((item) => [`${item.protocol}|${normalizeBase(item.baseUrl)}`, item.apiKey]));
  return imported.map((profile) => {
    if (profile.apiKey.trim()) return profile;
    // 只按「协议 + 归一化 Base URL」精确匹配；不同端点之间绝不继承 Key。
    const key = byBase.get(`${profile.protocol}|${normalizeBase(profile.baseUrl)}`) ?? '';
    return key ? { ...profile, apiKey: key } : profile;
  });
}

/** 兜底空数据：保证 providers/practice 一定存在。 */
export function normalizeAppShape(data: AppData): AppData {
  const practice = data.practice ?? DEFAULT_PRACTICE_SETTINGS;
  const providers = Array.isArray(data.providers) ? data.providers.slice(0, MAX_PROVIDERS) : [];
  const activeProviderId =
    data.activeProviderId && providers.some((item) => item.id === data.activeProviderId)
      ? data.activeProviderId
      : (providers[0]?.id ?? null);
  return { ...data, practice, providers, activeProviderId };
}
