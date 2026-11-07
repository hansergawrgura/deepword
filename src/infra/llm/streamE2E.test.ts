/**
 * 流式链路端到端测试：客户端 → 本地同源代理 → mock 上游（Anthropic SSE）。
 *
 * 覆盖 llm.test.ts（fetch 被 mock）覆盖不到的一环：**真实 HTTP 链路**上
 * 客户端是否真的在上游请求体里带 `stream:true`，以及代理是否把 SSE 逐块透传、
 * 客户端是否真的逐段回调 onToken。
 * 回归背景：曾经只把 stream 作为「代理响应提示」，上游请求体里没有 stream:true，
 * 于是上游返回整包 JSON，onToken 只回调一次，流式退化为一次性返回。
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type StartedServer } from '../../../server/proxy.mjs';
import type { LLMSettings } from '@/domain/types';
import { LLM_FORWARD_PATH, streamChat } from './forward';

let upstream: http.Server;
let upstreamPort = 0;
let receivedBody: Record<string, unknown> = {};

let proxy: StartedServer;
let realFetch: typeof fetch;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      try {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        receivedBody = {};
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\n',
      );
      res.write(
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n',
      );
      res.write(
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n',
      );
      res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as { port: number }).port;

  proxy = await startServer({ port: 0 });
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input === LLM_FORWARD_PATH) {
      return realFetch(`http://127.0.0.1:${proxy.port}${input}`, init);
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await proxy.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('e2e: 本地代理 + mock 上游 SSE', () => {
  it('上游请求体带 stream:true，且逐段回调 onToken', async () => {
    const settings: LLMSettings = {
      provider: 'anthropic',
      vendor: 'volcengine',
      thinkingMode: 'off',
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: 'sk-test',
      model: 'deepseek-v4.1-flash',
      temperature: 0,
      maxTokens: 128,
    };

    const tokens: string[] = [];
    const text = await streamChat(settings, [{ role: 'user', content: 'hi' }], {
      onToken: (token) => tokens.push(token),
    });

    console.log('tokens:', JSON.stringify(tokens), '| text:', JSON.stringify(text));
    expect(receivedBody.stream).toBe(true);
    expect(tokens).toEqual(['你', '好']);
    expect(text).toBe('你好');
  }, 30_000);
});
