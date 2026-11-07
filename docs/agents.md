# 协作分工（Agents）

本项目由 **1 位 Team Lead + 5 位协作代理** 在共享工作区中并行完成，最终由 Lead 集成、浏览器验收与独立 QA 复验后收口。本文记录分工边界、协作机制以及每位代理的交付物，作为后续迭代时复用该协作模式的参考。

---

## 1. 协作机制

| 机制 | 说明 |
| --- | --- |
| 共享工作区 | 所有代理读写同一个仓库目录，改动即时互相可见 |
| 写入范围隔离 | 每个任务声明 `write_scopes`（文件/目录前缀），任务之间不重叠，避免并行写入冲突 |
| 契约先行 | Lead 先完成 `src/types.ts`、`src/state/AppState.tsx`、`src/lib/llm/types.ts` 与各模块占位实现（签名固定），再分派任务；代理只实现、不改契约 |
| 共享任务板 | 每个任务包含完整验收标准；代理先 `claim` 再开发，完成后 `complete` 并 `send_message` 回报 |
| 质量门禁 | 每位代理自行运行 `pnpm typecheck`（以及负责模块的 `pnpm exec vitest run <路径>`），Lead 再跑全量 `typecheck / test / build` 与真实浏览器验收 |

---

## 2. 角色分工

### 2.1 Team Lead（主代理）

**职责**：需求拆解、契约与骨架、并行分派、集成、验收与文档。

- **基础工程**：Vite + React 19 + TS 5.9 脚手架、`tsconfig` 严格模式、别名、vitest 配置、`index.html`。
- **契约层（只由 Lead 维护）**：`src/types.ts`、`src/lib/llm/types.ts`、`src/lib/llm/index.ts` 与 `src/data/wordbank.ts`、`src/lib/fallbackExercises.ts` 的占位实现（锁定导出签名）。
- **状态与存储**：`src/state/AppState.tsx`（reducer + actions + 持久化 + Toast）、`src/lib/storage.ts`。
- **领域层**：`src/lib/srs.ts`、`session.ts`、`stats.ts`、`utils.ts` 及全部对应单测。
- **视图**：`App.tsx`（hash 路由 + 外壳 + 错误边界）、`Sidebar`、`Dashboard`、`WordbookView`、`SettingsView`、`components/ui/*`、`styles/*` 设计系统。
- **设计方向**：确立「宣纸 × 墨色 × 朱砂」的编辑感视觉，定义 `tokens.css` 设计变量、宋体/衬线字体栈、纸张纹理与朱砂强调规则，供各页面复用。
- **集成与验收**：接入各代理组件，跑全量构建/测试，用 headless Chrome（CDP）逐页截图与交互验证，包括对接 mock LLM 服务验证 OpenAI 与 Anthropic 两条真实 HTTP 链路、失败回退、备份导入导出、暗色与 390px 响应式。
- **收口**：处理 QA 反馈、修复集成级问题（skip link 路由、跨页样式、导出脚本等）、编写 README / docs / CHANGELOG。

### 2.2 llm-engine —— LLM 出题层

**写作用域**：`src/lib/llm/{providers,prompts,generate}.ts`、`src/lib/llm/index.ts`、`src/lib/llm/llm.test.ts`

- `providers.ts`：OpenAI 兼容 `/chat/completions`（JSON 模式，服务端 400/422 时自动降级重试）与 Anthropic `/messages`（system 拆分、浏览器直连头）、baseUrl 规范化与端点解析、90s 超时与取消、HTTP/网络/超时错误映射、`testLLMConnection` 永不抛错。
- `prompts.ts`：中文教研员系统提示 + 错词上下文用户提示，四类题型与可判分约束、三档难度，`PROMPT_VERSION = v1`。
- `generate.ts`：两段进度回调、JSON 容错提取、逐题严格校验/修正/选项打乱/去重/题量上限，失败抛带 code 的 `LLMError`。
- 测试：61 个 mock fetch 用例。

### 2.3 seed-builder —— 词库与离线出题

**写作用域**：`src/data/wordbank.ts`、`src/lib/fallbackExercises.ts`、`src/lib/fallbackExercises.test.ts`

- 190 个 CET-4 / CET-6 / 考研 / 雅思高频词（音标、词性、释义、自然例句与中文翻译、标签），含 adapt/adopt、principal/principle 等易混词与写作短语。
- 本地兜底出题器：错词加权选题、多词覆盖、choice/fill 混排、同词性近义干扰项、近义释义排除防双解、例句屈折形式挖空与等价答案、极小词库/脏数据不崩。
- 测试：24 个用例（含词库数据质量断言）。

### 2.4 study-ui —— 学习页（闪卡 SRS）

**写作用域**：`src/components/study/`

- 三阶段状态机：扉页（待复习/新词/掌握度 + 模式选择）→ 学习（词笺闪卡正反面、3D 翻面、四档自评与间隔预览）→ 成绩单（正确率、用时、四档分布、「再看一眼」词单）。
- 键盘：`Space` 开局/翻面、`1-4` 自评、`Esc` 结束；队列只在开局构建一次；移动端翻面后自动把评分按钮带入视野；删除词自动跳过；`prefers-reduced-motion` 适配。

### 2.5 drill-ui —— 错题特训页

**写作用域**：`src/components/drill/`

- 四阶段状态机：setup（错词清单/随机抽词、题量、难度、引擎状态与缺 Key 提示）→ generating（朱印「命题」、`onProgress` 分阶段文案、墨线进度、取消）→ quiz（试卷卡、1–4 / Enter 键盘判分、行内填空、即时朱批与中文解析、发音）→ result（正确率、批语、错题复盘、再练一组）。
- 失败态：按 `LLMError.code` 给出可操作建议，可重试或「改用本地题库继续」；每题判分立即 `recordExercise` 回写。
- 边界：取消/卸载中止请求、StrictMode 单请求、题量不足按实际题数完成、提前结束按已答部分结算。

### 2.6 qa-verifier —— 独立 QA 验收

**写作用域**：无（只读审查；脚本/截图/报告只写 `/tmp`）

- 不修改源码，独立复验：数据完整性（评分/判分/删除/导入/刷新后 `attempts`/`mistakes`/`srs`/`stats` 交叉一致）、损坏数据恢复、备份含/不含 Key、LLM 双协议真实 HTTP 链路（mock 服务）、失败回退、注入与 XSS、Key 泄漏检查、Study/Drill 状态机与快速点击/取消、词库导入、设置语义、390px 与暗色主题、可访问性、构建/测试/密钥卫生。
- 共 203 条断言，结论「可交付」，报出 4 项 P2；Lead 已全部修复并回归（导入备份后设置草稿同步、`words` 类型损坏改为备份+告警、按 id 去重、弹窗焦点陷阱/还原与 aria 状态）。

---

## 3. 时间线与关键决策

| 阶段 | 负责人 | 关键决策 |
| --- | --- | --- |
| 契约与骨架 | Lead | 单一 `AppData` + reducer 为唯一写入口；领域层纯函数化便于并行与测试；LLM 层签名先行占位，先并行后替换 |
| 并行开发 | 4 位代理 | 各自仅写自己的目录/文件，互不改契约 |
| 集成 | Lead | 只有本页需要才引入页面 CSS；统一 `.view-head` / `.view-actions` 等共享类；修复跨页样式外溢（`Wordbook.css` 的 `.view-actions` 改为 `.wordbook` 作用域） |
| 验收 | Lead + QA | mock LLM 服务真实驱动 OpenAI/Anthropic 两条 HTTP 链路，验证不依赖真实 Key；QA 独立做对抗测试 |
| 收口 | Lead | 修复 4 项 P2 + skip link 路由问题；更新 README/docs/CHANGELOG |

---

## 4. 若继续迭代，如何复用该模式

1. **Lead 先改契约**：改动 `types.ts` 时同步检查 `lib/llm/types.ts` 与所有占位签名，并给下游升级说明。
2. **任务描述必须自带**：目标、必读文件、写入范围、接口契约、交互/验收标准、自测命令、回报格式。
3. **新页面**：在 `src/components/<name>/` 内自成一体（组件 + CSS），只依赖 `useApp()` 与 `lib/` 纯函数。
4. **新 LLM 能力**：优先扩展 `lib/llm/providers.ts` 的纯函数与 `generate.ts` 的校验，保持 `generateExercises(request)` 签名稳定；变更提示词策略要递增 `PROMPT_VERSION`。
5. **改动数据结构**：递增 `DATA_VERSION` 并补迁移与「旧格式导入」测试（见 [版本规格](version-spec.md#4-数据格式版本dataversion)）。
6. **任何计划发布的改动**：同时更新 `CHANGELOG.md` 与 `docs/spec.md` 的验收条款。
