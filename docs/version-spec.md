# 版本规格（Version Spec）

本文档定义「词渊 DeepWord」的版本语义、命名规则、发布流程，以及**数据格式（localStorage）、LLM 提示词、对外接口契约**三套需要长期稳定的版本号体系。

---

## 1. 三条独立的版本线

| 版本线 | 常量 / 位置 | 当前值 | 变更意味着 | 兼容策略 |
| --- | --- | --- | --- | --- |
| **应用版本** | `package.json` 的 `version` | `1.2.0` | 功能、界面、依赖演进 | 遵循 SemVer（见 §2） |
| **数据版本** | `DATA_VERSION`（`src/types.ts`）、`STORAGE_KEY = 'deepword:data:v2'` | `2` | 本地数据结构的字段/语义变化 | 只升不降；升级走迁移（见 §4） |
| **提示词版本** | `PROMPT_VERSION`（`src/lib/llm/prompts.ts`），设置页「关于」展示 | `v1` | 出题策略、输出 JSON 结构、校验规则变化 | 旧题不追溯重校验；版本号进入日志/报告（见 §5） |
| **讲解提示词版本** | `FEEDBACK_PROMPT_VERSION`（`src/lib/llm/feedbackPrompts.ts`） | `v1` | AI 讲解 / 互译判分的提示词与协议变化 | 与出题提示词相互独立（见 §5） |

> 这三条线**互相独立**。只改界面 → 只升应用版本；只改数据结构 → 数据版本 +1 并附迁移；只改出题策略 → 提示词版本 +1。

---

## 2. 应用版本（SemVer）

格式 `MAJOR.MINOR.PATCH`：

- **MAJOR**：破坏性变更。典型场景：数据格式需要迁移且旧数据无法自动升级、LLM 协议变更导致既有配置失效、路由/存储键改名。
- **MINOR**：向后兼容的新能力。新增视图/题型/统计维度、新增 LLM 服务商预设、新增导出格式字段（只增不改不改语义）。
- **PATCH**：向后兼容的修复。文案、样式、边界 bug、性能优化、依赖补丁。

预发布：`1.2.0-beta.1`；内部试验：`0.x.y`（本项目已发布 `1.0.0`，不再使用 0.x 语义）。

### 2.1 1.1.0（Phase B）规格基线

> 说明：本版重构学习流程（闸门 + 6 技能混合出题 + 薄弱度复习 + AI 讲解 + TTS），属于**向后兼容的能力演进**
> （不删除既有视图与字段、不改变既有字段语义），按 **MINOR** 发布（`1.1.0`）。
> 数据结构只做**可缺省的新增字段**（`AppData.mastery` / `AppData.reviewPriority` / `AppData.session`、
> `PracticeSettings` / `PracticeResult` / `MasteryRecord`，以及 `Attempt` 的可选字段），旧 v2 数据可原样读取、
> **未触发数据迁移**，因此数据版本保持 `2`。

| 项目 | 承诺 |
| --- | --- |
| 学习流程 | 学习页两个 tab（学习 / 闪卡）；一轮 = 新词 N 个（默认 1，可调 1~10；每词 4~8 题，默认 6）→ 复习 4~6 词（题量 `词数～2×词数`，默认 10）→ 小结 → 继续下一轮；进度持久化、可恢复 |
| 题型 | 6 技能 `en2zh` / `zh2en` / `spell` / `listen` / `sentence` / `translate`，全部本地生成、离线可用；互译需 AI、听音需 TTS，互译占比 ≤ 1/3 |
| 掌握 | 连续 3 次全对 + ≥2 技能 + 14 天无错 + ≥2 轮次；可手动确认与取消掌握；掌握词永久退出学习与复习 |
| 反馈 | 答错流式讲解（错因 / 记忆点 / 改进），不自动跳题；答对本地鼓励语并按设置自动跳转（默认 3 秒）；互译三档 `perfect` / `good` / `poor`，`poor` 须读完讲解；失败降级本地解析 |
| 薄弱分析 | 6 维度从作答记录现算；仪表盘展示技能正确率、最弱词与建议重点；复习选词与出题技能按薄弱度优先 |
| 语音 | 浏览器 TTS：能力检测、英文语音选择、语速 0.5~2；无可用英文语音时不出听音题（云端 TTS、OS 级发音未做） |
| 数据 | `DATA_VERSION = 2` 不变；新增 `mastery` / `reviewPriority` 两个可缺省映射与 `session`，`Attempt` 追加可选字段，旧数据读取时补默认值 |
| 测试 | `pnpm test` 共 384 用例（学习流程 124、LLM 147、本地代理 14、存储 34、Provider 配置层 12、模型行合并 6，其余为 SRS / 统计 / 本地兜底出题等） |

### 2.2 1.0.1（Phase A）规格基线

> 说明：本版新增的 provider 管理、本地代理与流式基建均为向后兼容能力，数据从 v1 自动迁移、旧备份可导入，按 **patch** 发布（`1.0.1`）。学习流程重构等改动已在后续 `MINOR`（`1.1.0`，见 `docs/v2-design.md`）中完成。

| 项目 | 承诺 |
| --- | --- |
| 技术栈 | React 19、Vite 6、TypeScript 5.9；新增零依赖 Node 本地代理（`server/`），无 UI 组件库、无状态管理库 |
| 运行形态 | 不再是纯静态站点：dev `pnpm dev`（Vite 5173 + 内置 `/api` 代理），prod `pnpm build && pnpm start`（`127.0.0.1:8787` 单进程托管 `dist/` + `/api`） |
| 数据位置 | 本机浏览器 `localStorage`，主键 `deepword:data:v2`；旧键 `deepword:data:v1` 仅作迁移来源并保留一个 MINOR 周期 |
| LLM 链路 | 浏览器 → 同源 `POST /api/llm/forward` → 本地代理 → 厂商；浏览器不直接连接厂商，无需 CORS |
| LLM 协议 | OpenAI 兼容 `/chat/completions`、Anthropic `/v1/messages`（Base URL 填厂商前缀如 `/api/coding`、`/anthropic` 时自动补齐 `/v1`；填到版本层时只补 `/messages`）；模型列表 `GET {base}/models`（Ollama 可回落 `/api/tags`）；`streamChat` 支持 SSE 双协议 |
| provider | 最多 `MAX_PROVIDERS = 20` 份配置，同时仅一份「当前使用」；每份模型白名单 ≤ `MAX_MODELS_PER_PROVIDER = 300` |
| 词库规模 | 内置 190 词；用户词库上限 `MAX_WORDS = 10 000` |
| 作答记录 | 本地保留最近 `MAX_ATTEMPTS = 3 000` 条 |
| 测试 | 1.0.1 发布时 `pnpm test` 共 264 用例：LLM 144、本地代理 14、存储 34、Provider 配置层 12、模型行合并 6，其余为 SRS / 统计 / 会话 / 本地出题等（1.1.0 起为 384 用例，见 §2.1） |

### 2.3 1.0.0 规格基线

| 项目 | 承诺 |
| --- | --- |
| 技术栈 | React 19、Vite 6、TypeScript 5.9，无 UI 组件库、无状态管理库、无动画库 |
| 浏览器 | Chromium 系（Chrome/Edge）、Safari 16+、Firefox 最近两个大版本；需支持 `backdrop-filter`、CSS `color-mix`（Safari 16.2+ / Chrome 111+ / Firefox 113+），不支持时降级为普通背景色 |
| 数据位置 | 本机浏览器 `localStorage`，键 `deepword:data:v1`（1.0.0 基线；1.0.1 起迁移到 v2） |
| LLM 协议 | OpenAI 兼容 `/chat/completions`、Anthropic `/messages` |
| 词库规模 | 内置 190 词；用户词库上限 `MAX_WORDS = 10 000` |
| 作答记录 | 本地保留最近 `MAX_ATTEMPTS = 3 000` 条 |
| 测试 | `pnpm test` 覆盖 SRS / 统计 / 会话 / 存储 / 本地出题 / LLM 解析与校验 |

---

## 3. 依赖与工具版本要求

| 依赖 | 声明范围 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20（开发建议 22 LTS+） | Vite 6 / Vitest 3 要求；生产代理与静态托管只用 Node 内置模块（`http`/`fs`/`path`/`url`），不引入依赖 |
| pnpm | ≥ 9 | 仓库含 `pnpm-workspace.yaml`（仅声明 esbuild 构建许可） |
| react / react-dom | `^19.1.0` | 运行时唯一第三方依赖 |
| vite | `^6.3.0` | 构建与开发服务器（dev 经 middleware 提供 `/api`） |
| typescript | `^5.8.0` | 严格模式 + `noUnusedLocals` 等 |
| vitest | `^3.1.0` | 单元测试，环境 `node`；同时覆盖 `server/**/*.test.mjs` |

升级依赖的原则：`patch` 级随时可升；`minor` 级需跑完 `typecheck + test + build` 并在真实浏览器做一次冒烟；`major` 级（如 React 20、Vite 7）视为应用版本 `MINOR` 变更。

---

## 4. 数据格式版本（`DATA_VERSION`）

### 4.1 规则

1. **只增不改**：新增字段必须可缺省（读取层给默认值，见 `sanitize*` 系列函数）；已有字段的语义不得改变。
2. **升版本必须配迁移**：`DATA_VERSION` +1 时，在 `src/lib/storage.ts` 增加纯函数（本次为 `migrateV1ToV2(raw): raw`，后续按 `migrate_vN_to_vN+1` 命名），并在 `hydrateData` 入口按来源版本顺序执行。迁移必须有单测覆盖「旧格式 → 新格式」「新格式直读」两条路径，且不修改入参。
3. **读取层永远清洗**：`hydrateData` 对任意来源（localStorage、导入备份、迁移产物）执行完整的字段校验/裁剪/去重（按 `id` 与 `term` 双重去重），非法条目丢弃而不是抛错；结构性损坏（如 `words` 存在但类型错误）抛错，交由 `loadData` 备份 + 降级。
4. **存储键与版本绑定**：主键 `deepword:data:v2` 中的 `v2` 对应 `DATA_VERSION = 2`。旧键 `deepword:data:v1` 仅作为迁移来源：启动时检测到旧键 → `migrateV1ToV2` → 立即写入 v2 → **旧键保留（不清除）一个 MINOR 版本周期**，供降级排查；清空本地数据时两键一并删除。
5. **迁移触发条件**：`source.version === 1`，或「没有 `providers` 但有旧 `settings`」。迁移映射：旧 `settings` → 一份名为「默认配置」的 `ProviderProfile`（`vendor` 由 Base URL 推断、`models = [model]`、`thinkingMode = 'off'`）；补默认 `practice` / `session`；删除 `settings`；`version = 2`。
6. **损坏备份**：任何 v2 读取失败都会写入 `deepword:data:v2:corrupt:<timestamp>`（JSON 文本原样），读取旧键失败时写 `deepword:data:v1:corrupt:<timestamp>`。备份永不自动删除。

### 4.2 数据契约摘要（v2）

```ts
AppData {
  version: 2
  words: Word[]                    // id/term 唯一，term ≤ 64 字符，meaning ≤ 300
  srs: Record<wordId, SrsCard>     // 每个 word 必有卡；缺失时读取层补建
  attempts: Attempt[]              // 倒序（新→旧），上限 3000；可带 skill/latencyMs/verdict/roundId/aiFeedback/aiImprovement/aiStatus
  mistakes: Record<wordId, Mistake>// 仅 wrongCount > 0 的词
  providers: ProviderProfile[]     // ≤ MAX_PROVIDERS；baseUrl 为空的条目读取时丢弃；按 id 去重
  activeProviderId: string | null  // 必须指向 providers 中一项，否则回退首项；列表为空则 null
  practice: PracticeSettings       // 练习设置，默认值见 DEFAULT_PRACTICE_SETTINGS
  session?: PracticeSessionState | null // 当前一轮练习（Phase B：阶段/题目/逐题结果/讲解）
  mastery?: Record<wordId, MasteryRecord> // Phase B 新增（可缺省，读取层补 {}）：掌握标记
  reviewPriority?: Record<wordId, number> // Phase B 新增（可缺省，读取层补 {}）：闪卡「不认识」的复习优先
  theme: 'light' | 'dark'
  stats: LearningStats             // daily: 'YYYY-MM-DD' → DailyStat，保留最近 400 天
  createdAt / updatedAt: number    // 毫秒时间戳
}

ProviderProfile {
  id / name
  protocol: 'openai' | 'anthropic'
  vendor: Vendor                   // openai/anthropic/deepseek/qwen/ollama/kimi/glm/siliconflow/minimax/custom
  baseUrl: string
  apiKey: string                   // 仅本机；导出默认清空
  models: string[]                 // 模型白名单，≤ 300
  defaultModel: string             // 可不在白名单中（自定义 model id）
  temperature / maxTokens
  thinkingMode: 'off' | 'provider-default'
  createdAt / updatedAt
}

PracticeSettings {                 // 练习设置（1.1.0；Phase A 起即落盘，读取时补默认值）
  newWordsPerRound: number         // 每轮新词数，默认 1，区间 1~10
  questionsPerNewWord: number      // 每词题量，默认 6，区间 4~8
  reviewWordsPerRound: number      // 每轮复习词数，默认 6，区间 4~6
  reviewQuestionsPerRound: number  // 每轮复习题量，默认 10，区间 [复习词数, 2×复习词数]
  feedbackAutoAdvanceMs: number    // 答对自动跳转时长（ms）：3000 / 5000 / 0（手动）
  autoExplain: boolean             // 自动讲解开关，默认 true
  tts: { rate: number; voiceUri: string; autoPlay: boolean }  // 语速 0.5~2、英文语音、发音自动播放
}

PracticeSessionState {             // 当前一轮（1.1.0 新增，可缺省）
  id / startedAt
  stage: 'gate' | 'new' | 'review' | 'done'
  newWordIds: string[]             // 本轮新词（逐个过闸门）
  completedNewWordIds: string[]
  reviewWordIds: string[]
  answered / targetQuestions
  roundNo?: number                 // 轮次序号
  gate?: 'ask' | 'confirm' | null  // 闸门子阶段
  currentWordId?: string
  questions?: Exercise[]           // 当前阶段题目集
  questionIndex?: number
  results?: PracticeResult[]       // 本轮逐题结果与讲解（小结可回看）
}

PracticeResult {                   // 一轮中的单题结果（1.1.0 新增）
  questionId / wordId
  skill: Skill                     // en2zh | zh2en | spell | listen | sentence | translate
  exerciseType: ExerciseType
  prompt / response / answer
  correct: boolean
  verdict?: 'perfect' | 'good' | 'poor'   // 互译三档
  aiFeedback?: string              // 讲解（落库截断 ≤400）
  aiImprovement?: string           // 改进建议
  aiStatus?: 'ok' | 'failed' | 'local-fallback'
  latencyMs?: number
  answeredAt: number
}

MasteryRecord {                    // 掌握标记（1.1.0 新增）
  wordId: string
  masteredAt: number
  source: 'manual' | 'rule'        // 闸门手动确认 / 满足四条件自动标记
}
```

- `LLMSettings` **不再持久化**：任何需要它的地方都由 `resolveActiveLLMSettings(data)` 从 `activeProviderId` 指向的配置派生（`provider` / `vendor` / `thinkingMode` / `baseUrl` / `apiKey` / `model` / `temperature` / `maxTokens`）。
- `ExerciseType` 扩为 `choice | fill | spell | translate | sentence | usage | correction`；drill 仍只使用 `choice` / `fill` / `usage` / `correction`。
- `Skill`（1.1.0）：`en2zh | zh2en | spell | listen | sentence | translate`，写在 `Exercise.skill` 与 `Attempt.skill` 上。
- `Attempt` 新增字段均可缺省（`skill` / `latencyMs` / `verdict` / `roundId` / `aiFeedback` / `aiImprovement` / `aiStatus`），旧数据读取时保持 undefined，历史统计口径不变。
- `AppData.mastery` / `AppData.reviewPriority` / `AppData.session` 均**可缺省**：读取层补 `{}` / `{}` / `null`，因此 1.1.0 不需要数据迁移。

### 4.3 备份格式

```json
{
  "app": "deepword",
  "scheme": "deepword-backup",
  "version": 2,
  "exportedAt": "2026-11-07T02:00:00.000Z",
  "data": { "...AppData 的完整结构，每份 provider 的 apiKey 默认为空字符串" }
}
```

- `version` 对应 `DATA_VERSION`（当前 `2`），导入时按 §4.1 规则迁移。
- 导入接受两种输入：上述包装对象，或裸 `AppData` 对象；**1.0.0 导出的 v1 备份同样可导入**（自动迁移）。
- `includeApiKey: true` 时导出明文 Key，仅用于个人本机迁移；UI 默认关闭并显式提示风险。
- 导入语义：**覆盖当前词库、学习记录与配置**；备份中缺失的 API Key 按 `protocol + Base URL` 从本机现有配置继承（备份带了非空 Key 时以备份为准）。

---

## 5. 提示词与出题契约版本（`PROMPT_VERSION`）

- 修改以下任一项必须递增：系统提示词策略、题型集合或判分方式、输出 JSON 字段、`sanitizeExercise` 校验规则、每词题量上限（当前 2）、难度档位语义。
- 版本号格式 `vN`（当前 `v1`），在设置页「关于」展示，便于排查「某次出题结果变差」是否由提示词变更引起。
- **1.0.1 的提示词与出题策略保持不变**（`v1`）：本版的 `streamChat` 属于传输基建，不改变 prompt。
- **1.1.0 新增讲解提示词版本** `FEEDBACK_PROMPT_VERSION = v1`（`src/lib/llm/feedbackPrompts.ts`）：答错讲解输出「错因 / 记忆点 / 改进」三段；互译判分采用行协议——首行 `VERDICT: perfect|good|poor`，空行后为讲解正文。改这套提示词或协议时递增该版本号，出题提示词 `PROMPT_VERSION` 不受影响。
- 生成结果写入 `Exercise.source = 'llm'`；本地兜底为 `'local'`，不计入提示词版本。
- `Exercise` 契约（两种来源都必须满足）：
  - `choice` / `usage` / `correction`：`options` 3~4 个互不重复，`answer` 严格等于某一项原文；
  - `fill`：`prompt` 含连续下划线 `____`（或全角 `＿＿＿＿`），`answer` 非空，等价答案合并在 `acceptableAnswers`；
  - `prompt ≤ 500` 字符，`explanation ≤ 400` 字符（超长截断），`difficulty` 为 1~5 整数；
  - 判分：`normalizeAnswer` 后比较（去首尾空白、折叠空格、忽略大小写与结尾标点），填空命中 `answer` 或任一 `acceptableAnswers` 即正确。

---

## 6. 发布流程

1. 功能分支 → 本地 `pnpm typecheck && pnpm test && pnpm build` 全绿；
2. 真实浏览器冒烟（桌面 + 390px + 暗色）：今日 / 学习 / 特训（本地兜底 + 真实或 mock LLM）/ 词库 / 设置；`pnpm dev`（Vite 代理）与 `pnpm build && pnpm start`（生产代理）两条路径各走一遍；
3. 代理检查：`GET /api/health` 返回 `200 {"ok":true}`；仅监听回环地址；未启动代理时 AI 提示可读且可回退本地题库；
4. 数据变更的额外检查：旧版本数据文件导入 → 迁移 → 刷新 → 内容一致；v1 备份导入可用；旧键仍在；
5. 更新 `CHANGELOG.md`（见格式约定）；
6. 升 `package.json` 版本号；若有数据/提示词变更，同步升 `DATA_VERSION` / `PROMPT_VERSION` 并补迁移与测试；
7. 提交信息遵循 Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`），提交信息正文用中文描述用户可见变化。

## 7. 兼容性与弃用策略

- 应用版本 `MAJOR` 升级可以移除视图/字段，但**必须**提供导出备份与迁移说明。
- 数据字段弃用：先「写入停止 + 读取兼容」保留一个 `MINOR` 周期，再在下一个 `MAJOR` 中移除。
- 旧数据键 `deepword:data:v1` 在 v2 启用后保留一个 `MINOR` 周期（默认不清除），之后可评估移除；清空本地数据仍会同时删除 v1/v2 两键。
- LLM 服务商预设（Base URL / 模型名）随服务商变化调整属于 `PATCH`；新增预设属于 `MINOR`。
- 本地代理线协议（`POST /api/llm/forward`、`GET /api/health`、错误 code 白名单 `bad-request|network|timeout`）是稳定契约；新增字段只增不改。
- 设置中 `hasUsableLLMConfig` 的判定口径（`baseUrl` 与 `model` 非空，`apiKey` 允许为空以支持本地 Ollama）是稳定契约；1.0.1 起该判定作用于 `resolveActiveLLMSettings(data)` 派生出的当前配置，改动需谨慎并同步 README 与设置页文案。
