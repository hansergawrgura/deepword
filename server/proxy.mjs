// dpdp-word same-origin LLM proxy (dev Vite middleware + prod static server).

import http from 'node:http';
import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 转发请求体上限：1 MB。 */
export const MAX_FORWARD_BODY_BYTES = 1 * 1024 * 1024;
/** 上游连接（等待响应头）超时：20s。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
/** 上游请求总超时：90s。 */
export const DEFAULT_TOTAL_TIMEOUT_MS = 90_000;

/** 允许转发给上游的请求头（小写）。 */
const FORWARD_HEADER_ALLOWLIST = new Set([
  'authorization',
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'content-type',
  'accept',
]);

/** 即使将来白名单变动也必须显式剥离的头（小写）。 */
const FORWARD_HEADER_DENYLIST = new Set([
  'origin',
  'referer',
  'cookie',
]);

/** 上游响应中可以安全回传的头（小写）。 */
const RESPONSE_HEADER_PASSTHROUGH = new Map([
  ['content-type', 'content-type'],
  ['location', 'location'],
  ['retry-after', 'retry-after'],
  ['x-request-id', 'x-request-id'],
]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_METHODS = new Set(['GET', 'POST']);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);

const DEFAULT_DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url));

// ---------------------------------------------------------------------------
// 错误与响应工具
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function badRequest(message) {
  return new ApiError(400, 'bad-request', message);
}

function payloadTooLarge(message) {
  return new ApiError(413, 'bad-request', message);
}

function sendJson(res, status, payload, extraHeaders = undefined) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  };
  try {
    res.writeHead(status, headers);
    res.end(body);
  } catch {
    res.destroy();
  }
}

function sendProxyError(res, status, code, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, status, { error: { code, message } });
}

function getPathname(url) {
  try {
    return new URL(url || '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

function isLoopbackHost(host) {
  return typeof host === 'string' && LOOPBACK_HOSTS.has(host.toLowerCase());
}

// ---------------------------------------------------------------------------
// 请求体读取
// ---------------------------------------------------------------------------

/**
 * 读取并限制请求体大小。超过 limit 立即以 PAYLOAD_TOO_LARGE 拒绝（不再读入内存）。
 * 客户端中途断开时以 CLIENT_ABORTED 拒绝。
 */
function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    // 兜底：settle 之后仍可能收到 socket error，避免未处理的 error 事件导致进程崩溃。
    req.on('error', () => {});

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      fn();
    };

    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        // 已经超限：继续 drain，不再缓存，交给调用方回 413。
        settle(() => {
          const err = payloadTooLarge(
            `请求体超过 ${Math.round(limit / 1024)} KB 上限`,
          );
          err.code = 'PAYLOAD_TOO_LARGE';
          reject(err);
        });
        // 停止读取后让剩余数据流走（不进内存），以便安全回 413 并关闭连接。
        req.resume();
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      settle(() => resolve(Buffer.concat(chunks).toString('utf8')));
    };

    const onError = () => {
      settle(() => {
        const err = new Error('读取请求体失败');
        err.code = 'CLIENT_ABORTED';
        reject(err);
      });
    };

    const onClose = () => {
      // complete=false 表示客户端在写完请求体前断开。
      if (req.complete) return;
      settle(() => {
        const err = new Error('客户端已断开');
        err.code = 'CLIENT_ABORTED';
        reject(err);
      });
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

// ---------------------------------------------------------------------------
// 请求体校验
// ---------------------------------------------------------------------------

function parseForwardPayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('请求体不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('请求体必须是 JSON 对象');
  }

  const { url, method = 'POST', headers, body, stream = false } = parsed;

  if (typeof url !== 'string' || url.length === 0) {
    throw badRequest('缺少 url');
  }
  let target;
  try {
    target = new URL(url);
  } catch {
    throw badRequest('url 不是合法 URL');
  }
  if (!ALLOWED_PROTOCOLS.has(target.protocol)) {
    throw badRequest('url 仅支持 http/https');
  }
  if (target.username || target.password) {
    throw badRequest('url 不允许包含凭据');
  }

  if (typeof method !== 'string' || !ALLOWED_METHODS.has(method.toUpperCase())) {
    throw badRequest('method 仅支持 GET/POST');
  }

  if (headers !== undefined && headers !== null) {
    if (typeof headers !== 'object' || Array.isArray(headers)) {
      throw badRequest('headers 必须是对象');
    }
  } else {
    parsed.headers = {};
  }

  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw badRequest('body 必须是已序列化的字符串');
  }

  if (typeof stream !== 'boolean') {
    throw badRequest('stream 必须是布尔值');
  }

  const forwardHeaders = pickForwardHeaders(headers);
  const normalizedMethod = method.toUpperCase();

  return {
    target,
    method: normalizedMethod,
    headers: forwardHeaders,
    // GET 不携带 body（fetch 也不允许）。
    body: normalizedMethod === 'GET' ? undefined : (body ?? undefined),
    stream,
  };
}

/** 只保留白名单头，且强制剥离 Origin/Referer/Cookie。 */
function pickForwardHeaders(rawHeaders) {
  const result = {};
  if (!rawHeaders) return result;
  for (const [rawName, value] of Object.entries(rawHeaders)) {
    const name = String(rawName).toLowerCase();
    if (FORWARD_HEADER_DENYLIST.has(name)) continue;
    if (!FORWARD_HEADER_ALLOWLIST.has(name)) continue;
    if (typeof value !== 'string') continue;
    if (value.length > 8192) continue;
    result[name] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 转发
// ---------------------------------------------------------------------------

function clearTimer(timer) {
  if (timer) clearTimeout(timer);
}

/** 把一块上游数据写回客户端，返回是否还可以继续写。 */
function writeChunk(res, chunk) {
  if (res.writableEnded || res.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(value);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    res.on('drain', onDrain);
    res.on('close', onClose);
    if (res.write(chunk)) finish(true);
  });
}

function applyUpstreamResponseHeaders(res, upstream, streaming) {
  for (const [name, canonical] of RESPONSE_HEADER_PASSTHROUGH) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(canonical, value);
  }
  if (streaming) {
    if (!res.hasHeader('Content-Type')) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
  } else {
    if (!res.hasHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.setHeader('Cache-Control', 'no-store');
  }
}

async function handleForward(req, res, config) {
  let clientAborted = false;
  let timedOut = false;
  const controller = new AbortController();

  const onClientClose = () => {
    if (res.writableFinished || res.writableEnded) return;
    clientAborted = true;
    controller.abort();
  };
  res.on('close', onClientClose);
  res.on('error', () => {});

  try {
    let raw;
    try {
      raw = await readRequestBody(req, config.maxBodyBytes);
    } catch (err) {
      if (clientAborted) {
        res.destroy();
        return;
      }
      if (err && err.code === 'PAYLOAD_TOO_LARGE') {
        sendJson(
          res,
          413,
          { error: { code: 'bad-request', message: err.message } },
          { Connection: 'close' },
        );
        return;
      }
      sendProxyError(res, 400, 'bad-request', '读取请求体失败');
      return;
    }

    let request;
    try {
      request = parseForwardPayload(raw);
    } catch (err) {
      if (err instanceof ApiError) {
        sendProxyError(res, err.status, err.code, err.message);
      } else {
        sendProxyError(res, 400, 'bad-request', '请求参数不合法');
      }
      return;
    }

    const connectTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.connectTimeoutMs);
    const totalTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.totalTimeoutMs);

    let upstream;
    try {
      upstream = await fetch(request.target, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimer(connectTimer);
      clearTimer(totalTimer);
      if (clientAborted) {
        res.destroy();
        return;
      }
      if (timedOut) {
        sendProxyError(res, 504, 'timeout', '上游连接超时');
        return;
      }
      const cause = err && err.cause && err.cause.code ? err.cause.code : '';
      sendProxyError(
        res,
        502,
        'network',
        cause ? `无法连接上游服务（${cause}）` : '无法连接上游服务',
      );
      return;
    }

    // 已拿到响应头：连接超时不再适用；总超时继续计时。
    clearTimer(connectTimer);

    try {
      res.statusCode = upstream.status;

      if (request.stream) {
        applyUpstreamResponseHeaders(res, upstream, true);
        if (!res.headersSent) res.flushHeaders();

        if (upstream.body) {
          const reader = upstream.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const canContinue = await writeChunk(res, value);
              if (!canContinue) {
                await reader.cancel().catch(() => {});
                break;
              }
            }
          } catch (err) {
            if (!clientAborted && !timedOut) {
              // 上游流中途断开：已发头就截断连接。
              if (!res.writableEnded) res.destroy();
              return;
            }
            throw err;
          }
        }
        if (!res.writableEnded) res.end();
      } else {
        const buffer = Buffer.from(await upstream.arrayBuffer());
        applyUpstreamResponseHeaders(res, upstream, false);
        res.setHeader('Content-Length', String(buffer.length));
        if (!res.headersSent) res.writeHead(res.statusCode);
        res.end(buffer);
      }
    } catch (err) {
      if (clientAborted) {
        res.destroy();
        return;
      }
      if (timedOut) {
        if (res.headersSent) res.destroy();
        else sendProxyError(res, 504, 'timeout', '上游请求超时');
        return;
      }
      if (err instanceof ApiError && err.status === 413) {
        sendProxyError(res, 413, 'bad-request', err.message);
        return;
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendProxyError(res, 502, 'network', '上游响应读取失败');
    } finally {
      clearTimer(totalTimer);
    }
  } finally {
    res.off('close', onClientClose);
  }
}

function handleHealth(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendProxyError(res, 405, 'bad-request', '仅支持 GET');
    return;
  }
  sendJson(res, 200, { ok: true });
}

async function routeApi(req, res, config) {
  const pathname = getPathname(req.url);

  if (pathname === '/api/health') {
    handleHealth(req, res);
    return;
  }
  if (pathname === '/api/llm/forward') {
    if (req.method !== 'POST') {
      sendProxyError(res, 405, 'bad-request', '仅支持 POST');
      return;
    }
    await handleForward(req, res, config);
    return;
  }
  sendProxyError(res, 404, 'bad-request', '未知的 API 路径');
}

/**
 * 创建 Node http API handler，处理：
 * - GET  /api/health
 * - POST /api/llm/forward
 * 其余 /api 返回 404 JSON。
 *
 * options.timeoutMs：测试注入用的统一短超时；生产不传，走默认 20s/90s。
 */
export function createApiHandler(options = {}) {
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError('timeoutMs 必须是正数');
  }

  const config = {
    maxBodyBytes: options.maxBodyBytes ?? MAX_FORWARD_BODY_BYTES,
    connectTimeoutMs: options.connectTimeoutMs ?? timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    totalTimeoutMs: options.totalTimeoutMs ?? timeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
  };
  for (const name of ['connectTimeoutMs', 'totalTimeoutMs', 'maxBodyBytes']) {
    if (!Number.isFinite(config[name]) || config[name] <= 0) {
      throw new TypeError(`${name} 必须是正数`);
    }
  }

  return async function apiHandler(req, res) {
    try {
      await routeApi(req, res, config);
    } catch {
      if (!res.writableEnded && !res.destroyed) {
        sendProxyError(res, 500, 'network', '代理内部错误');
      } else {
        res.destroy();
      }
    }
  };
}

/**
 * 创建 Vite dev-server 中间件：只接管 /api，其余路径调用 next()。
 * 返回的中间件不抛出异步错误（内部已兜底）。
 */
export function createViteMiddleware(options = {}) {
  const handler = createApiHandler(options);
  return function viteApiMiddleware(req, res, next) {
    const pathname = getPathname(req.url);
    if (pathname !== '/api' && !pathname.startsWith('/api/')) {
      next();
      return;
    }
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.writableEnded && !res.destroyed) {
        sendProxyError(res, 500, 'network', '代理内部错误');
      }
    });
  };
}

// ---------------------------------------------------------------------------
// 静态资源（prod：托管 dist/）
// ---------------------------------------------------------------------------

function resolveStaticPath(distDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const rel = decoded.replace(/^\/+/, '');
  const candidate = path.resolve(distDir, rel);
  if (candidate !== distDir && !candidate.startsWith(distDir + path.sep)) {
    return null;
  }
  return candidate;
}

async function sendFile(req, res, filePath, { immutable = false } = {}) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', MIME_TYPES.get(ext) ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader(
    'Cache-Control',
    immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  );
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return true;
}

async function serveStatic(req, res, distDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendProxyError(res, 405, 'bad-request', '仅支持 GET/HEAD');
    return;
  }

  const pathname = getPathname(req.url);
  const indexHtml = path.join(distDir, 'index.html');

  if (pathname === '/' || pathname === '/index.html') {
    await serveIndex(res, indexHtml);
    return;
  }

  const candidate = resolveStaticPath(distDir, pathname);
  if (candidate) {
    try {
      const sent = await sendFile(req, res, candidate, {
        immutable: pathname.startsWith('/assets/'),
      });
      if (sent) return;
    } catch {
      // 落到 SPA fallback。
    }
  }

  // SPA fallback：无扩展名的路由（如 /settings）返回 index.html；静态文件缺失则 404。
  if (path.extname(pathname) === '') {
    await serveIndex(res, indexHtml);
    return;
  }

  const notFound = 'Not Found';
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(notFound)),
    'Cache-Control': 'no-store',
  });
  res.end(notFound);
}

async function serveIndex(res, indexHtml) {
  const html = await fsp.readFile(indexHtml);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(html.length),
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

/**
 * 启动 prod 服务：托管 dist/ + /api。
 * 端口默认 8787、host 默认 127.0.0.1（仅监听本机回环）。
 * dist 不存在时抛出 code='DIST_MISSING' 的中文错误，由 server/index.mjs 打印并以非 0 退出。
 */
export async function startServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host)) {
    const err = new Error(
      `仅允许监听本机回环地址（127.0.0.1/localhost/::1），收到 HOST=${host}`,
    );
    err.code = 'HOST_NOT_LOOPBACK';
    throw err;
  }

  const distDir = options.distDir ?? DEFAULT_DIST_DIR;
  const indexHtml = path.join(distDir, 'index.html');
  try {
    await fsp.access(indexHtml);
  } catch {
    const err = new Error(
      `未找到构建产物 ${indexHtml}。请先运行 pnpm build，再运行 node server/index.mjs。`,
    );
    err.code = 'DIST_MISSING';
    throw err;
  }

  const port = options.port ?? 8787;
  const apiHandler = createApiHandler(options);

  const server = http.createServer((req, res) => {
    const pathname = getPathname(req.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      Promise.resolve(apiHandler(req, res)).catch(() => {
        sendProxyError(res, 500, 'network', '代理内部错误');
      });
      return;
    }
    serveStatic(req, res, distDir).catch(() => {
      if (!res.headersSent) {
        sendProxyError(res, 500, 'network', '静态资源服务失败');
      } else {
        res.destroy();
      }
    });
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
    server.listen(port, host);
  });

  const actualPort = server.address().port;

  return {
    server,
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise((resolve) => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(() => resolve());
      }),
  };
}
