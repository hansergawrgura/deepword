// dpdp-word production server: node server/index.mjs
//
// - /api/* 交给 server/proxy.mjs（/api/health、/api/llm/forward）
// - 其余路径托管 dist/（SPA fallback 到 index.html）
// - 只监听本机回环地址；dist 不存在时给中文提示并以非 0 退出
//
// 环境变量：PORT（默认 8787）、HOST（默认 127.0.0.1，仅允许回环地址）。

import { startServer } from './proxy.mjs';

const DEFAULT_PORT = 8787;

function resolvePort() {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const err = new Error(`PORT 不是合法端口号：${raw}`);
    err.code = 'BAD_PORT';
    throw err;
  }
  return port;
}

async function main() {
  let port;
  try {
    port = resolvePort();
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const host = process.env.HOST ?? '127.0.0.1';

  let started;
  try {
    started = await startServer({ port, host });
  } catch (err) {
    if (err && err.code === 'DIST_MISSING') {
      console.error(err.message);
    } else if (err && err.code === 'EADDRINUSE') {
      console.error(
        `端口 ${port} 已被占用。请先停止占用该端口的进程，或设置 PORT 环境变量换一个端口。`,
      );
    } else if (err && err.code === 'HOST_NOT_LOOPBACK') {
      console.error(err.message);
    } else if (err && err.code === 'BAD_PORT') {
      console.error(err.message);
    } else {
      console.error(`启动失败：${err && err.message ? err.message : String(err)}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`dpdp-word local server: ${started.url}`);
  console.log('Press Ctrl+C to stop.');

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Stopping dpdp-word local server…');
    try {
      await started.close();
    } catch {
      // 退出流程不因关闭失败而卡住。
    }
  };

  process.once('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });
}

await main();
