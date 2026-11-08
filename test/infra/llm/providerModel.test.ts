import { describe, expect, it } from 'vitest';
import type { ProviderProfile } from '@/domain/types';
import {
  checkBaseUrl,
  inferVendorFromBaseUrl,
  preserveApiKeys,
} from '@/infra/llm/providerModel';

function profile(partial: Partial<ProviderProfile> & Pick<ProviderProfile, 'id' | 'baseUrl'>): ProviderProfile {
  return {
    name: '',
    protocol: 'openai',
    vendor: 'custom',
    apiKey: '',
    models: [],
    defaultModel: '',
    temperature: 0.7,
    maxTokens: 2_500,
    thinkingMode: 'off',
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe('checkBaseUrl', () => {
  it('rejects empty or non-http(s) URLs', () => {
    expect(checkBaseUrl('').ok).toBe(false);
    expect(checkBaseUrl('not-a-url').ok).toBe(false);
    expect(checkBaseUrl('ftp://example.com').ok).toBe(false);
  });

  it('accepts http(s) URLs with a host', () => {
    expect(checkBaseUrl('https://api.deepseek.com/v1').ok).toBe(true);
    expect(checkBaseUrl('http://localhost:11434/v1').ok).toBe(true);
  });
});

describe('inferVendorFromBaseUrl', () => {
  it('maps known hosts', () => {
    expect(inferVendorFromBaseUrl('https://api.openai.com/v1', 'openai')).toBe('openai');
    expect(inferVendorFromBaseUrl('https://api.anthropic.com/v1', 'anthropic')).toBe('anthropic');
    expect(inferVendorFromBaseUrl('https://api.deepseek.com/v1', 'openai')).toBe('deepseek');
    expect(inferVendorFromBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1', 'openai')).toBe(
      'qwen',
    );
    expect(inferVendorFromBaseUrl('http://127.0.0.1:11434/v1', 'openai')).toBe('ollama');
  });

  it('only treats Ark /api/coding as volcengine under anthropic protocol', () => {
    expect(
      inferVendorFromBaseUrl('https://ark.cn-beijing.volces.com/api/coding', 'anthropic'),
    ).toBe('volcengine');
    expect(inferVendorFromBaseUrl('https://ark.cn-beijing.volces.com/api/v3', 'openai')).toBe(
      'custom',
    );
  });
});

describe('preserveApiKeys', () => {
  it('inherits key by protocol + normalized base URL when backup key is empty', () => {
    const current = [
      profile({
        id: 'local',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1/',
        apiKey: 'sk-local',
      }),
    ];
    const imported = [
      profile({
        id: 'backup',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
      }),
    ];
    expect(preserveApiKeys(imported, current)[0]?.apiKey).toBe('sk-local');
  });

  it('does not inherit across different endpoints or when backup has a key', () => {
    const current = [
      profile({
        id: 'local',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-local',
      }),
    ];
    expect(
      preserveApiKeys(
        [profile({ id: 'other', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '' })],
        current,
      )[0]?.apiKey,
    ).toBe('');
    expect(
      preserveApiKeys(
        [
          profile({
            id: 'backup',
            protocol: 'openai',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKey: 'sk-backup',
          }),
        ],
        current,
      )[0]?.apiKey,
    ).toBe('sk-backup');
  });
});
