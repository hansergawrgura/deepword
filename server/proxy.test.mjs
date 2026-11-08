import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createApiHandler, createViteMiddleware } from './proxy.mjs';

const cleanupTasks = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    try {
      await task();
    } catch {
      // 测试清理失败不影响其它用例。
    }
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 监听 127.0.0.1:0，并登记清理逻辑（销毁残留 socket，避免 server.close 挂住）。
 */
async function listenServer(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const port = server.address().port;
  cleanupTasks.push(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${port}`;
}

async function startMock(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('mock error');
    });
  });
  return { server, baseUrl: await listenServer(server) };
}

async function startProxy(options = {}) {
  const server = http.createServer(createApiHandler(options));
  return { server, baseUrl: await listenServer(server) };
}

function forward(baseUrl, payload, init = {}) {
  return fetch(`${baseUrl}/api/llm/forward`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    body: JSON.stringify(payload),
    // 测试客户端自身不跟随重定向，避免把上游 302 当成代理行为。
    redirect: 'manual',
    ...init,
  });
}

function getPathname(url) {
  return new URL(url, 'http://127.0.0.1').pathname;
}

async function readJson(response) {
  return response.json();
}

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  it('返回 200 {"ok":true}', async () => {
    const proxy = await startProxy();
    const res = await fetch(`${proxy.baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// JSON 透传
// ---------------------------------------------------------------------------

describe('POST /api/llm/forward · JSON 透传', () => {
  const UPSTREAM_BODY =
    '{"id":"chatcmpl-1","choices":[{"message":{"content":"你好"}}]}';

  it('状态码与 body 原样透传', async () => {
    const mock = await startMock((req, res) => {
      if (getPathname(req.url) === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(UPSTREAM_BODY);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const proxy = await startProxy();
    const res = await forward(proxy.baseUrl, { url: `${mock.baseUrl}/json` });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UPSTREAM_BODY);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('上游 401 的 status 与 body 原样透传', async () => {
    const upstreamBody = '{"error":{"message":"invalid api key"}}';
    const mock = await startMock((req, res) => {
      if (getPathname(req.url) === '/unauthorized') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(upstreamBody);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const proxy = await startProxy();
    const res = await forward(proxy.baseUrl, {
      url: `${mock.baseUrl}/unauthorized`,
    });

    expect(res.status).toBe(401);
    expect(await res.text()).toBe(upstreamBody);
  });
});

// ---------------------------------------------------------------------------
// SSE 逐块透传
// ---------------------------------------------------------------------------

describe('POST /api/llm/forward · SSE', () => {
  it('上游分块发送时逐块到达（收到多段）', async () => {
    const parts = [
      'data: {"delta":"一"}\n\n',
      'data: {"delta":"二"}\n\n',
      'data: [DONE]\n\n',
    ];
    const mock = await startMock(async (req, res) => {
      if (getPathname(req.url) !== '/sse') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      for (const part of parts) {
        res.write(part);
        await sleep(40);
      }
      res.end();
    });

    const proxy = await startProxy();
    const res = await forward(proxy.baseUrl, {
      url: `${mock.baseUrl}/sse`,
      stream: true,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.body).not.toBeNull();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }

    const text = chunks.join('');
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(text).toContain('一');
    expect(text).toContain('二');
    expect(text).toContain('[DONE]');
  });
});

// ---------------------------------------------------------------------------
// 头剥离
// ---------------------------------------------------------------------------

describe('POST /api/llm/forward · 请求头', () => {
  it('只转发白名单头，剥离 Origin/Referer/Cookie', async () => {
    const mock = await startMock((req, res) => {
      if (getPathname(req.url) === '/headers') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.headers));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const proxy = await startProxy();
    const res = await forward(proxy.baseUrl, {
      url: `${mock.baseUrl}/headers`,
      headers: {
        authorization: 'Bearer sk-test-secret',
        'x-api-key': 'sk-test-key',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'messages-2023-12-15',
        'content-type': 'application/json',
        accept: 'application/json',
        origin: 'http://evil.example',
        referer: 'http://evil.example',
        cookie: 'session=secret',
      },
    });

    expect(res.status).toBe(200);
    const received = await readJson(res);

    expect(received.authorization).toBe('Bearer sk-test-secret');
    expect(received['x-api-key']).toBe('sk-test-key');
    expect(received['anthropic-version']).toBe('2023-06-01');
    expect(received['anthropic-beta']).toBe('messages-2023-12-15');
    expect(received['content-type']).toBe('application/json');
    expect(received.accept).toBe('application/json');

    expect(received.origin).toBeUndefined();
    expect(received.referer).toBeUndefined();
    expect(received.cookie).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 重定向
// ---------------------------------------------------------------------------

describe('POST /api/llm/forward · 重定向', () => {
  it("302 不跟随（redirect:'manual'）", async () => {
    let followedTarget = 0;
    const mock = await startMock((req, res) => {
      const pathname = getPathname(req.url);
      if (pathname === '/redirect') {
        res.writeHead(302, { Location: '/target' });
        res.end();
        return;
      }
      if (pathname === '/target') {
        followedTarget += 1;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('should-not-be-fetched');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const proxy = await startProxy();
    const res = await forward(proxy.baseUrl, {
      url: `${mock.baseUrl}/redirect`,
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/target');
    expect(followedTarget).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 上游不可达
// ---------------------------------------------------------------------------

describe('POST /api/llm/forward · 上游不可达', () => {
  it('无错误码的网络失败返回 502 network（不是 400）', async () => {
    const dead = http.createServer();
    const deadBase = await listenServer(dead);
    await new Promise((resolve) => dead.close(resolve));

    const proxy = await startProxy();
    const res = await forward(proxy.baseUrl, { url: `${deadBase}/probe` });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('network');
  });
});

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

describe('POST /api/llm/forward · 参数校验', () => {
  it('坏 url（file:）返回 400 bad-request', async () => {
    const proxy = await startProxy();
    const res = await forward(proxy.baseUrl, { url: 'file:///etc/passwd' });

    expect(res.status).toBe(400);
    const body = await readJson(res);
    expect(body.error.code).toBe('bad-request');
  });

  it('data: 协议同样被拒绝', async () => {
    const proxy = await startProxy();
    const res = await forward(proxy.baseUrl, {
      url: 'data:text/plain,hello',
    });
    expect(res.status).toBe(400);
  });

  it('超过 1 MB 的请求体返回 413', async () => {
    const mock = await startMock((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    const proxy = await startProxy();

    const oversized = 'x'.repeat(1_200_000);
    const res = await forward(proxy.baseUrl, {
      url: `${mock.baseUrl}/echo`,
      body: oversized,
    });

    expect(res.status).toBe(413);
    const body = await readJson(res);
    expect(body.error.code).toBe('bad-request');
  });

  it('未知 /api 路径返回 404 JSON', async () => {
    const proxy = await startProxy();
    const res = await fetch(`${proxy.baseUrl}/api/unknown`);
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 超时
// ---------------------------------------------------------------------------

describe('POST /api/llm/forward · 超时', () => {
  it('上游挂起时按注入的 300ms 超时返回 504 timeout', async () => {
    const mock = await startMock((req, res) => {
      // 故意不响应，制造连接超时。
      if (getPathname(req.url) === '/hang') return;
      res.writeHead(404);
      res.end();
    });

    const proxy = await startProxy({ timeoutMs: 300 });
    const startedAt = performance.now();
    const res = await forward(proxy.baseUrl, {
      url: `${mock.baseUrl}/hang`,
    });
    const elapsed = performance.now() - startedAt;

    expect(res.status).toBe(504);
    const body = await readJson(res);
    expect(body.error.code).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });
});

// ---------------------------------------------------------------------------
// 客户端断开
// ---------------------------------------------------------------------------

describe('POST /api/llm/forward · 客户端 abort', () => {
  it('客户端断开时取消上游请求', async () => {
    let resolveUpstreamClosed;
    const upstreamClosed = new Promise((resolve) => {
      resolveUpstreamClosed = resolve;
    });

    const mock = await startMock((req, res) => {
      if (getPathname(req.url) !== '/slow-sse') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
      });
      res.write('data: hello\n\n');

      let notified = false;
      const onClose = () => {
        if (notified) return;
        notified = true;
        resolveUpstreamClosed();
      };
      req.on('close', onClose);
      res.on('close', onClose);
    });

    const proxy = await startProxy();
    const controller = new AbortController();

    const res = await forward(
      proxy.baseUrl,
      { url: `${mock.baseUrl}/slow-sse`, stream: true },
      { signal: controller.signal },
    );

    const reader = res.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('hello');

    controller.abort();
    await reader.cancel().catch(() => {});

    const closed = await Promise.race([
      upstreamClosed.then(() => true),
      sleep(2000).then(() => false),
    ]);
    expect(closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Vite 中间件：只接管 /api
// ---------------------------------------------------------------------------

describe('createViteMiddleware', () => {
  it('非 /api 路径调用 next，/api 由代理接管', async () => {
    const fallbackText = 'static-fallback';
    const middleware = createViteMiddleware();
    const app = http.createServer((req, res) => {
      middleware(req, res, () => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(fallbackText);
      });
    });
    const baseUrl = await listenServer(app);

    const staticRes = await fetch(`${baseUrl}/index.html`);
    expect(await staticRes.text()).toBe(fallbackText);

    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
    expect(await readJson(health)).toEqual({ ok: true });
  });
});
