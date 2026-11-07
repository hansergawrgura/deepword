# Phase A 契约（1.0.1）

团队协作的唯一契约。实现方只读，不改本文件；契约要变先找 Lead。

## 目标

多 provider 管理 + 本地代理 + 流式 + `DATA_VERSION 1→2` 迁移。设计见 `docs/v2-design.md`。

## 写入域（互不重叠）

| 域 | 文件 |
| --- | --- |
| Lead | `src/types.ts`、`src/lib/providerModel.ts`、`src/lib/llm/{index,types}.ts`、`src/state/AppState.tsx`、`docs/*`、`README.md`、`package.json`（版本号最后） |
| proxy-core | `server/**`、`vite.config.ts`、`package.json`（仅 scripts） |
| llm-client | `src/lib/llm/providers.ts`、`src/lib/llm/llm.test.ts` |
| providers-ui | `src/components/SettingsView.tsx`、`src/components/Settings.css`、`src/components/providers/**`、`src/components/drill/{DrillView,SetupStage,meta}.ts(x)`（仅改 settings 取值方式） |
| data-migration | `src/lib/storage.ts`、`src/lib/storage.test.ts` |

不碰别人域。需要改契约：给 Lead 发消息，别自己改。

## 本地代理线协议（proxy-core 实现，llm-client 消费）

同源请求（dev：Vite 5173 middleware；prod：`node server/index.mjs` 托管 dist + API）。

```
POST /api/llm/forward
req JSON: {
  url: string,                      // 必须 http(s)
  method?: 'GET' | 'POST',          // 默认 POST
  headers?: Record<string,string>,  // 允许：authorization, x-api-key, anthropic-version,
                                    // anthropic-beta, content-type, accept
  body?: string,                    // 已序列化 JSON 文本（≤1 MB）
  stream?: boolean                  // true 透传 SSE
}
res: 上游原始状态码 + 原始 body（stream 时逐块透传 text/event-stream）
     代理自身错误：4xx/502/504 + JSON {"error":{"code":"bad-request|network|timeout","message":string}}
GET /api/health -> 200 {"ok":true}
```

代理规则（必须）：仅 `http/https`；`redirect:'manual'` 不跟随；剥离 `Origin/Referer/Cookie`；不记录 body/header（含 Key）；不缓存；上游连接超时 20 s、总超时 90 s；客户端断开即 abort 上游；非 `/api` 路径交回 next / 静态资源。

## 冻结导出（Lead 已写，实现方必须满足）

`src/lib/llm/index.ts`：

```ts
export { generateExercises } from './generate';
export { chatComplete, fetchModels, hasUsableLLMConfig, streamChat, testLLMConnection } from './providers';
export { PROMPT_VERSION } from './prompts';
export type { ChatCompleteOptions, ChatMessage, ExerciseRequest, ExerciseTarget,
  FetchModelsResult, LLMConnectionResult, ModelInfo, StreamChatOptions } from './types';
export { LLMError } from './types';
```

- `chatComplete(settings, messages, opts?: ChatCompleteOptions & {jsonMode?, timeoutMs?}): Promise<string>`
- `streamChat(settings, messages, opts?: StreamChatOptions): Promise<string>`（`onToken` 逐段回调；`noThink` 默认 false）
- `fetchModels(settings): Promise<FetchModelsResult>`（永不抛错；失败给 `warning` + 空列表）
- `testLLMConnection(settings): Promise<LLMConnectionResult>`（永不抛错；只看成功响应，不要求内容非空；`maxTokens:1` + 强制 noThink）
- 传输一律经 `/api/llm/forward`；不再发 `anthropic-dangerous-direct-browser-access`；不再直连厂商域名。
- 思考参数按 `settings.vendor` 白名单注入；`thinkingMode==='off'` 或 `noThink` 时生效；400 且错误含参数名 → 去掉思考参数重试一次。

| vendor | 关闭思考参数 |
| --- | --- |
| anthropic | `thinking:{type:'disabled'}` |
| deepseek | `thinking:{type:'disabled'}` |
| qwen | `enable_thinking:false` |
| ollama | `reasoning_effort:'none'` |
| kimi | `thinking:{type:'disabled'}`（K3 系列改 `reasoning_effort:'low'`） |
| glm | `thinking:{type:'disabled'}` |
| siliconflow | `enable_thinking:false` |
| volcengine（火山方舟） | `thinking:{type:'disabled'}` |
| openai | `reasoning_effort:'minimal'` |
| minimax / custom / 缺省 | 不发 |

`src/lib/providerModel.ts`（Lead 已写）：`VENDOR_OPTIONS`、`VENDOR_PRESETS`、`inferVendorFromBaseUrl`、`toLLMSettings`、`findActiveProvider`、`resolveActiveLLMSettings(data)`、`checkBaseUrl`、`providerSummaryText`、`legacySettingsToProfile`、`preserveApiKeys`、`normalizeAppShape`、`createInitialProviders`、`DEFAULT_LEGACY_SETTINGS`。

`src/state/AppState.tsx`（Lead 已写）：`data.providers`、`data.activeProviderId`、`data.practice`；actions `addProvider(draft)→{ok,message,id?}`、`updateProvider(id,draft)`、`deleteProvider(id)`、`setActiveProvider(id|null)`；`data.settings` 已删除，用 `resolveActiveLLMSettings(data)`。

`src/lib/storage.ts`（data-migration 交付）必须导出：
`STORAGE_KEY`(v2)、`LEGACY_STORAGE_KEY`、`MAX_WORDS`、`MAX_ATTEMPTS`、`createInitialData`、`loadData`、`saveData`、`exportBackup`、`parseBackup`、`getStorageUsage`、`clearStoredData`、`resetProgress`、`resetWordsToSeed`、`makeWord`、`normalizeWord`、`hydrateData`、`migrateV1ToV2`。

- 初始数据 = 示例词库 + 1 份默认 provider + 默认 practice。
- `hydrateData`：`source.version === 1` 或「无 providers 但有旧 settings」→ 迁移，再全量清洗。
- 导出备份：provider 的 `apiKey` **默认清空**，`includeApiKey=true` 时保留；版本写 2；导入旧包装/裸 v1 数据都能迁移。
- `clearStoredData` 同时删 v1/v2 键；`getStorageUsage` 读 v2 键。

## 状态口径

- 卡片状态 `new/learning/review/mastered` 保留；Phase A 不实现掌握逻辑。
- `Attempt` 新字段（可缺省）：`skill?`、`latencyMs?`、`verdict?`、`aiFeedback?`、`aiImprovement?`、`aiStatus?`。
- `ExerciseType` 扩为 `choice|fill|spell|translate|sentence|usage|correction`。

## 自测命令

- 全量：`pnpm typecheck && pnpm test && pnpm build`
- 各域：`pnpm exec vitest run <自己的 test 路径>`。`pnpm typecheck` 可能因别人未完成而红；不是自己域的错误不用管。
- 允许临时红；最终由 Lead 集成收口。

## 回报格式（send_message 给 Lead）

`任务 <id> 完成｜文件：…｜测试：…（通过数）｜未决：…｜需要 Lead 改契约的点：…`