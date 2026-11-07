import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export interface ApiProxyOptions {
  /** 测试注入：统一缩短连接/总超时（生产不传，走契约默认 20s/90s）。 */
  timeoutMs?: number;
  /** 上游连接（等待响应头）超时，默认 20000。 */
  connectTimeoutMs?: number;
  /** 上游请求总超时，默认 90000。 */
  totalTimeoutMs?: number;
  /** 转发请求体上限，默认 1 MB。 */
  maxBodyBytes?: number;
}

export interface StartServerOptions extends ApiProxyOptions {
  /** 默认 8787。 */
  port?: number;
  /** 默认 127.0.0.1（仅允许回环地址）。 */
  host?: string;
  /** 默认仓库内 dist/。 */
  distDir?: string;
}

export type ApiHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

export type ViteApiMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

export interface StartedServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export declare const MAX_FORWARD_BODY_BYTES: number;
export declare const DEFAULT_CONNECT_TIMEOUT_MS: number;
export declare const DEFAULT_TOTAL_TIMEOUT_MS: number;

export declare function createApiHandler(
  options?: ApiProxyOptions,
): ApiHandler;

export declare function createViteMiddleware(
  options?: ApiProxyOptions,
): ViteApiMiddleware;

export declare function startServer(
  options?: StartServerOptions,
): Promise<StartedServer>;
