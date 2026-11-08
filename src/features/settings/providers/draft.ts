import type { TranslateFn } from '@/i18n';
import { toLLMSettings } from '@/infra/llm/providerModel';
import type {
  LLMSettings,
  ProviderDraft,
  ProviderKind,
  ProviderProfile,
  ThinkingMode,
} from '@/domain/types';

export const PROTOCOL_KINDS: readonly ProviderKind[] = ['openai', 'anthropic'];

export function protocolLabel(protocol: ProviderKind, t: TranslateFn): string {
  return protocol === 'anthropic' ? t('providers.anthropicLabel') : t('providers.openaiCompat');
}

export function thinkingModeLabel(mode: ThinkingMode, t: TranslateFn): string {
  return mode === 'provider-default'
    ? t('providers.thinkingProviderDefault')
    : t('providers.thinkingTryOff');
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
