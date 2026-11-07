# 版本规格（Version Spec）

本文档定义「词渊 DeepWord」的版本语义、命名规则、发布流程，以及**数据格式（localStorage）、LLM 提示词、对外接口契约**三套需要长期稳定的版本号体系。

---

## 1. 三条独立的版本线

| 版本线 | 常量 / 位置 | 当前值 | 变更意味着 | 兼容策略 |
| --- | --- | --- | --- | --- |
| **应用版本** | `package.json` 的 `version` | `1.0.0` | 功能、界面、依赖演进 | 遵循 SemVer（见 §2） |
| **数据版本** | `DATA_VERSION`（`src/types.ts`）、`STORAGE_KEY = 'deepword:data:v1'` | `1` | 本地数据结构的字段/语义变化 | 只升不降；升级走迁移（见 §4） |
| **提示词版本** | `PROMPT_VERSION`（`src/lib/llm/prompts.ts`），设置页「关于」展示 | `v1` | 出题策略、输出 JSON 结构、校验规则变化 | 旧题不追溯重校验；版本号进入日志/报告（见 §5） |

> 这三条线**互相独立**。只改界面 → 只升应用版本；只改数据结构 → 数据版本 +1 并附迁移；只改出题策略 → 提示词版本 +1。

---

## 2. 应用版本（SemVer）

格式 `MAJOR.MINOR.PATCH`：

- **MAJOR**：破坏性变更。典型场景：数据格式需要迁移且旧数据无法自动升级、LLM 协议变更导致既有配置失效、路由/存储键改名。
- **MINOR**：向后兼容的新能力。新增视图/题型/统计维度、新增 LLM 服务商预设、新增导出格式字段（只增不改不改语义）。
- **PATCH**：向后兼容的修复。文案、样式、边界 bug、性能优化、依赖补丁。

预发布：`1.2.0-beta.1`；内部试验：`0.x.y`（本项目已发布 `1.0.0`，不再使用 0.x 语义）。

### 1.0.0（首个版本）规格基线

| 项目 | 承诺 |
| --- | --- |
| 技术栈 | React 19、Vite 6、TypeScript 5.9，无 UI 组件库、无状态管理库、无动画库 |
| 浏览器 | Chromium 系（Chrome/Edge）、Safari 16+、Firefox 最近两个大版本；需支持 `backdrop-filter`、CSS `color-mix`（Safari 16.2+ / Chrome 111+ / Firefox 113+），不支持时降级为普通背景色 |
| 数据位置 | 本机浏览器 `localStorage`，键 `deepword:data:v1`；无后端、无网络账号 |
| LLM 协议 | OpenAI 兼容 `/chat/completions`、Anthropic `/messages` |
| 词库规模 | 内置 190 词；用户词库上限 `MAX_WORDS = 10 000` |
| 作答记录 | 本地保留最近 `MAX_ATTEMPTS = 3 000` 条 |
| 测试 | `pnpm test` 覆盖 SRS / 统计 / 会话 / 存储 / 本地出题 / LLM 解析与校验 |

---

## 3. 依赖与工具版本要求

| 依赖 | 声明范围 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20（开发建议 22 LTS+） | Vite 6 / Vitest 3 要求 |
| pnpm | ≥ 9 | 仓库含 `pnpm-workspace.yaml`（仅声明 esbuild 构建许可） |
| react / react-dom | `^19.1.0` | 运行时唯一第三方依赖 |
| vite | `^6.3.0` | 构建与开发服务器 |
| typescript | `^5.8.0` | 严格模式 + `noUnusedLocals` 等 |
| vitest | `^3.1.0` | 单元测试，环境 `node` |

升级依赖的原则：`patch` 级随时可升；`minor` 级需跑完 `typecheck + test + build` 并在真实浏览器做一次冒烟；`major` 级（如 React 20、Vite 7）视为应用版本 `MINOR` 变更。

---

## 4. 数据格式版本（`DATA_VERSION`）

### 4.1 规则

1. **只增不改**：新增字段必须可缺省（读取层给默认值，见 `sanitize*` 系列函数）；已有字段的语义不得改变。
2. **升版本必须配迁移**：`DATA_VERSION` +1 时，在 `src/lib/storage.ts` 增加 `migrate_vN_to_vN+1(raw): raw`，并在 `hydrateData` 入口按 `source.version` 顺序执行。迁移应是纯函数，且必须有单测覆盖「旧格式 → 新格式」与「新格式直读」两条路径。
3. **读取层永远清洗**：`hydrateData` 对任意来源（localStorage、导入备份、迁移产物）执行完整的字段校验/裁剪/去重（按 `id` 与 `term` 双重去重），非法条目丢弃而不是抛错；结构性损坏（如 `words` 存在但类型错误）抛错，交由 `loadData` 备份 + 降级。
4. **存储键与版本绑定**：`deepword:data:v1` 中的 `v1` 对应 `DATA_VERSION = 1`。若迁移策略选择「新键 + 一次性迁移」而非原地升级，则键名升为 `deepword:data:v2`，并在启动时检测旧键、迁移后保留旧键一个版本周期。
5. **损坏备份**：任何读取失败都会写入 `deepword:data:v1:corrupt:<timestamp>`（JSON 文本原样），最多保留最近若干份（实现方负责，至少 1 份）。备份永不自动删除。

### 4.2 数据契约摘要（v1）

```ts
AppData {
  version: 1
  words: Word[]                    // id/term 唯一，term ≤ 64 字符，meaning ≤ 300
  srs: Record<wordId, SrsCard>     // 每个 word 必有卡；缺失时读取层补建
  attempts: Attempt[]              // 倒序（新→旧），上限 3000
  mistakes: Record<wordId, Mistake>// 仅 wrongCount > 0 的词
  settings: LLMSettings            // baseUrl/model 必填，apiKey 可为空
  theme: 'light' | 'dark'
  stats: LearningStats             // daily: 'YYYY-MM-DD' → DailyStat，保留最近 400 天
  createdAt / updatedAt: number    // 毫秒时间戳
}
```

### 4.3 备份格式

```json
{
  "app": "deepword",
  "scheme": "deepword-backup",
  "version": 1,
  "exportedAt": "2026-11-07T02:00:00.000Z",
  "data": { "...AppData 的完整结构，apiKey 默认为空字符串" }
}
```

- `version` 对应 `DATA_VERSION`，导入时按 §4.1 规则迁移。
- 导入接受两种输入：上述包装对象，或裸 `AppData` 对象。
- `includeApiKey: true` 时导出明文 Key，仅用于个人本机迁移；UI 默认关闭并显式提示风险。
- 导入语义：**覆盖当前词库与学习记录**，保留当前 API Key（除非备份带了非空 Key，此时取备份值）。

---

## 5. 提示词与出题契约版本（`PROMPT_VERSION`）

- 修改以下任一项必须递增：系统提示词策略、题型集合或判分方式、输出 JSON 字段、`sanitizeExercise` 校验规则、每词题量上限（当前 2）、难度档位语义。
- 版本号格式 `vN`（当前 `v1`），在设置页「关于」展示，便于排查「某次出题结果变差」是否由提示词变更引起。
- 生成结果写入 `Exercise.source = 'llm'`；本地兜底为 `'local'`，不计入提示词版本。
- `Exercise` 契约（两种来源都必须满足）：
  - `choice` / `usage` / `correction`：`options` 3~4 个互不重复，`answer` 严格等于某一项原文；
  - `fill`：`prompt` 含连续下划线 `____`（或全角 `＿＿＿＿`），`answer` 非空，等价答案合并在 `acceptableAnswers`；
  - `prompt ≤ 500` 字符，`explanation ≤ 400` 字符（超长截断），`difficulty` 为 1~5 整数；
  - 判分：`normalizeAnswer` 后比较（去首尾空白、折叠空格、忽略大小写与结尾标点），填空命中 `answer` 或任一 `acceptableAnswers` 即正确。

---

## 6. 发布流程

1. 功能分支 → 本地 `pnpm typecheck && pnpm test && pnpm build` 全绿；
2. 真实浏览器冒烟（桌面 + 390px + 暗色）：今日 / 学习 / 特训（本地兜底 + 真实或 mock LLM）/ 词库 / 设置；
3. 数据变更的额外检查：旧版本数据文件导入 → 迁移 → 刷新 → 内容一致；
4. 更新 `CHANGELOG.md`（见格式约定）；
5. 升 `package.json` 版本号；若有数据/提示词变更，同步升 `DATA_VERSION` / `PROMPT_VERSION` 并补迁移与测试；
6. 提交信息遵循 Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`），提交信息正文用中文描述用户可见变化。

## 7. 兼容性与弃用策略

- 应用版本 `MAJOR` 升级可以移除视图/字段，但**必须**提供导出备份与迁移说明。
- 数据字段弃用：先「写入停止 + 读取兼容」保留一个 `MINOR` 周期，再在下一个 `MAJOR` 中移除。
- LLM 服务商预设（Base URL / 模型名）随服务商变化调整属于 `PATCH`；新增预设属于 `MINOR`。
- 设置中 `hasUsableLLMConfig` 的判定口径（baseUrl 与 model 非空，apiKey 允许为空以支持本地 Ollama）是稳定契约，改动需谨慎并同步 README 与设置页文案。
