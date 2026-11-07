/** Provider 设置用的本地草稿工具：profile ⇄ draft ⇄ LLMSettings。 */

import { toLLMSettings } from '../../lib/providerModel';
import type {
  LLMSettings,
  ProviderDraft,
  ProviderKind,
  ProviderProfile,
  ThinkingMode,
} from '../../types';

export const PROTOCOL_OPTIONS: ReadonlyArray<{
  value: ProviderKind;
  label: string;
  hint: string;
}> = [
  {
    value: 'openai',
    label: 'OpenAI 兼容',
    hint: '适用于 OpenAI、DeepSeek、通义千问、Kimi、智谱、硅基流动、Ollama 等兼容接口。',
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    hint: 'Anthropic Messages API；Base URL 填厂商给的前缀即可（官方 https://api.anthropic.com/v1、火山方舟 https://ark.cn-beijing.volces.com/api/coding），程序会自动补齐 /v1/messages。',
  },
];

export function protocolLabel(protocol: ProviderKind): string {
  return protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容';
}

export function thinkingModeLabel(mode: ThinkingMode): string {
  return mode === 'provider-default' ? '交给服务商默认' : '尽量关闭';
}

/** 新建配置时的空白草稿。 */
export function emptyProviderDraft(): ProviderDraft {
  return {
    name: '',
    protocol: 'openai',
    vendor: 'custom',
    baseUrl: '',
    apiKey: '',
    models: [],
    defaultModel: '',
    temperature: 0.7,
    maxTokens: 2_500,
    thinkingMode: 'off',
  };
}

/** 编辑已有配置时，把 profile 拍平为可编辑草稿。 */
export function draftFromProfile(profile: ProviderProfile): ProviderDraft {
  return {
    name: profile.name,
    protocol: profile.protocol,
    vendor: profile.vendor,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    models: [...profile.models],
    defaultModel: profile.defaultModel,
    temperature: profile.temperature,
    maxTokens: profile.maxTokens,
    thinkingMode: profile.thinkingMode,
  };
}

/** 用表单草稿构造测试连接 / 拉取模型所需的 LLMSettings。 */
export function draftToLLMSettings(draft: ProviderDraft): LLMSettings {
  return toLLMSettings({ ...draft, id: 'draft', createdAt: 0, updatedAt: 0 });
}
