/**
 * Provider 配置层单测：厂商推断、URL 校验、迁移、导入 Key 继承、空数据兜底。
 */

import { describe, expect, it } from 'vitest';
import type { AppData, ProviderProfile } from '../types';
import { createInitialData } from './storage';
import {
  checkBaseUrl,
  inferVendorFromBaseUrl,
  legacySettingsToProfile,
  normalizeAppShape,
  preserveApiKeys,
  toLLMSettings,
  VENDOR_PRESETS,
} from './providerModel';

const NOW = new Date('2026-11-07T12:00:00+08:00').getTime();

function makeProvider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'p-test',
    name: '测试配置',
    protocol: 'openai',
    vendor: 'custom',
    baseUrl: 'https://example.test/v1',
    apiKey: 'sk-test',
    models: ['m1'],
    defaultModel: 'm1',
    temperature: 0.7,
    maxTokens: 2_500,
    thinkingMode: 'off',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('inferVendorFromBaseUrl', () => {
  it('按主机名推断常见厂商', () => {
    expect(inferVendorFromBaseUrl('https://api.openai.com/v1', 'openai')).toBe('openai');
    expect(inferVendorFromBaseUrl('https://api.anthropic.com/v1', 'anthropic')).toBe('anthropic');
    expect(inferVendorFromBaseUrl('https://api.deepseek.com/v1', 'openai')).toBe('deepseek');
    expect(inferVendorFromBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1', 'openai')).toBe('qwen');
    expect(inferVendorFromBaseUrl('http://localhost:11434/v1', 'openai')).toBe('ollama');
    expect(inferVendorFromBaseUrl('https://api.moonshot.cn/v1', 'openai')).toBe('kimi');
    expect(inferVendorFromBaseUrl('https://open.bigmodel.cn/api/paas/v4', 'openai')).toBe('glm');
    expect(inferVendorFromBaseUrl('https://api.siliconflow.cn/v1', 'openai')).toBe('siliconflow');
    expect(inferVendorFromBaseUrl('https://api.minimax.chat/v1', 'openai')).toBe('minimax');
    expect(
      inferVendorFromBaseUrl('https://ark.cn-beijing.volces.com/api/coding', 'anthropic'),
    ).toBe('volcengine');
  });

  it('火山方舟只在 Anthropic 协议下推断为 volcengine，OpenAI 端点回退 custom', () => {
    expect(
      inferVendorFromBaseUrl('https://ark.cn-beijing.volces.com/api/coding', 'anthropic'),
    ).toBe('volcengine');
    expect(inferVendorFromBaseUrl('https://ark.cn-beijing.volces.com/api/v3', 'openai')).toBe(
      'custom',
    );
  });

  it('未知主机按协议回退，空地址按协议回退', () => {
    expect(inferVendorFromBaseUrl('https://my-gateway.test/v1', 'openai')).toBe('custom');
    expect(inferVendorFromBaseUrl('https://my-gateway.test/v1', 'anthropic')).toBe('anthropic');
    expect(inferVendorFromBaseUrl('', 'openai')).toBe('custom');
    expect(inferVendorFromBaseUrl('', 'anthropic')).toBe('anthropic');
  });
});

describe('VENDOR_PRESETS', () => {
  it('火山方舟预设指向 Anthropic 兼容的 Coding 端点', () => {
    expect(VENDOR_PRESETS.volcengine.protocol).toBe('anthropic');
    expect(VENDOR_PRESETS.volcengine.baseUrl).toBe(
      'https://ark.cn-beijing.volces.com/api/coding',
    );
    expect(VENDOR_PRESETS.volcengine.model).toBe('deepseek-v4.1-flash');
  });
});

describe('checkBaseUrl', () => {
  it('接受 http/https，拒绝空值与非法协议', () => {
    expect(checkBaseUrl('https://api.deepseek.com/v1').ok).toBe(true);
    expect(checkBaseUrl('http://127.0.0.1:11434/v1').ok).toBe(true);
    expect(checkBaseUrl('').ok).toBe(false);
    expect(checkBaseUrl('not a url').ok).toBe(false);
    expect(checkBaseUrl('file:///tmp/x').ok).toBe(false);
    expect(checkBaseUrl('ftp://example.test').ok).toBe(false);
  });
});

describe('legacySettingsToProfile', () => {
  it('把 v1 settings 映射成一份 profile 并推断厂商', () => {
    const profile = legacySettingsToProfile(
      {
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant',
        model: 'claude-sonnet-4-5',
        temperature: 1.2,
        maxTokens: 4_096,
      },
      NOW,
    );
    expect(profile.protocol).toBe('anthropic');
    expect(profile.vendor).toBe('anthropic');
    expect(profile.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(profile.models).toEqual(['claude-sonnet-4-5']);
    expect(profile.defaultModel).toBe('claude-sonnet-4-5');
    expect(profile.apiKey).toBe('sk-ant');
    expect(profile.temperature).toBe(1.2);
    expect(profile.maxTokens).toBe(4_096);
    expect(profile.thinkingMode).toBe('off');
  });

  it('toLLMSettings 把 profile 还原成 LLMSettings', () => {
    const settings = toLLMSettings(makeProvider({ vendor: 'deepseek', protocol: 'openai' }));
    expect(settings.provider).toBe('openai');
    expect(settings.vendor).toBe('deepseek');
    expect(settings.model).toBe('m1');
    expect(settings.thinkingMode).toBe('off');
  });
});

describe('preserveApiKeys', () => {
  it('同协议 + 同 Base URL（忽略大小写与尾斜杠）继承本机 Key', () => {
    const imported = [
      makeProvider({ id: 'a', apiKey: '', baseUrl: 'https://api.deepseek.com/v1/' }),
    ];
    const current = [
      makeProvider({ id: 'b', apiKey: 'sk-local', baseUrl: 'https://API.deepseek.com/v1' }),
    ];
    expect(preserveApiKeys(imported, current)[0].apiKey).toBe('sk-local');
  });

  it('Base URL 不同就不继承（即使本机只有一份配置）', () => {
    const imported = [
      makeProvider({ id: 'a', apiKey: '', baseUrl: 'https://api.openai.com/v1' }),
    ];
    const current = [
      makeProvider({ id: 'b', apiKey: 'sk-local', baseUrl: 'https://api.deepseek.com/v1' }),
    ];
    expect(preserveApiKeys(imported, current)[0].apiKey).toBe('');
  });

  it('备份自带非空 Key 时以备份为准', () => {
    const imported = [
      makeProvider({ id: 'a', apiKey: 'sk-backup', baseUrl: 'https://api.deepseek.com/v1' }),
    ];
    const current = [
      makeProvider({ id: 'b', apiKey: 'sk-local', baseUrl: 'https://api.deepseek.com/v1' }),
    ];
    expect(preserveApiKeys(imported, current)[0].apiKey).toBe('sk-backup');
  });
});

describe('normalizeAppShape', () => {
  function makeData(overrides: Partial<AppData> = {}): AppData {
    return { ...createInitialData(NOW), ...overrides };
  }

  it('恢复缺失的 practice，裁掉超限与重复 provider', () => {
    const data = makeData({ practice: undefined as never });
    const providers = Array.from({ length: 25 }, (_, index) =>
      makeProvider({ id: `p${index % 22}`, baseUrl: `https://host${index}.test/v1` }),
    );
    const normalized = normalizeAppShape({ ...data, providers });
    expect(normalized.practice).toBeDefined();
    expect(normalized.providers.length).toBeLessThanOrEqual(20);
    expect(new Set(normalized.providers.map((item) => item.id)).size).toBe(
      normalized.providers.length,
    );
  });

  it('非法 activeProviderId 回退首条，空列表为 null', () => {
    const data = makeData();
    const providers = [makeProvider({ id: 'x' })];
    expect(normalizeAppShape({ ...data, providers, activeProviderId: 'missing' }).activeProviderId).toBe('x');
    expect(normalizeAppShape({ ...data, providers: [], activeProviderId: 'missing' }).activeProviderId).toBe(null);
  });
});
