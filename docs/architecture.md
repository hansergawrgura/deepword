# 架构说明（Architecture）

「词渊 DeepWord」是**纯前端、无后端、本地优先**的单页应用。所有数据在浏览器 `localStorage` 中，所有逻辑在浏览器内运行，唯一的出站请求是用户自己配置的 LLM 接口。

---

## 1. 设计原则

1. **本地优先**：没有服务器、账号与遥测；断网时可完整使用（除 AI 出题外），练习自动回退本地题库。
2. **单一数据源**：整个应用状态是一个 `AppData` 对象，由 `AppState` 用 `useReducer` 维护，任何写操作都必须经过 action；组件不直接读写 `localStorage`。
3. **纯函数化的领域层**：排程、队列、统计、存储清洗、本地出题、LLM 解析与校验都是可在 Node 中单测的纯函数；React 组件只负责渲染和交互。
4. **模型输出不可信**：LLM 返回内容一律经过 JSON 提取 + 逐题严格校验，不合法即丢弃；题干与解析按纯文本渲染。
5. **契约先行**：`src/types.ts` 是所有领域类型的唯一来源；跨模块（LLM 层、UI 层、CLI 测试）只依赖这里的类型与 `lib/llm/types.ts` 的请求/响应类型。

---

## 2. 分层结构

```
┌──────────────────────────────────────────────────────────────┐
│ 视图层  src/components/**                                     │
│  Dashboard / study/ / drill/ / WordbookView / SettingsView    │
│  ui/：Modal、ConfirmDialog、ToastStack、icons                 │
├──────────────────────────────────────────────────────────────┤
│ 状态层  src/state/AppState.tsx                                │
│  useReducer(AppData) + AppActions + Toast + 持久化副作用     │
├──────────────────────────────────────────────────────────────┤
│ 领域层  src/lib/                                              │
│  srs.ts  session.ts  stats.ts  fallbackExercises.ts           │
│  storage.ts  utils.ts  llm/{providers,prompts,generate}.ts    │
├──────────────────────────────────────────────────────────────┤
│ 数据层                                                    │
│  src/types.ts（领域类型）  src/data/wordbank.ts（内置词库）   │
│  browser localStorage（键 deepword:data:v1）                  │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 视图层

- 每个页面是一个**受控视图**，接收 `ViewProps { navigate(view) }`，通过 `useApp()` 读取 `data`、调用 `actions`。
- 页面之间零共享可变状态：需要派生的数据（队列、统计、弱词）在渲染时用领域层纯函数即时计算（`useMemo`），或按交互时机构建一次（如学习队列只有在「开始本轮」时构建）。
- 样式分两级：全局设计系统（`styles/tokens.css` 变量、`styles/base.css` 排版、`styles/ui.css` 共享组件类）+ 页面目录内的同名 CSS。所有颜色/字体/间距/动效均走 CSS 变量，暗色主题只需覆盖 `[data-theme='dark']` 下的变量。
- 外壳 `App.tsx` 负责 hash 路由、错误边界、跳转链接与页脚；`Sidebar` 负责导航、连续天数、主题切换。

### 2.2 状态层（`AppState.tsx`）

- **状态**：`data: AppData`（`useReducer`）、`toasts`。
- **Action**：`GRADE_WORD`、`RECORD_EXERCISE`、`ADD_WORD`、`UPDATE_WORD`、`DELETE_WORD`、`IMPORT_WORDS`、`UPDATE_SETTINGS`、`SET_THEME`、`IMPORT_DATA`、`RESET_ALL`、`CLEAR_PROGRESS`。
- **Reducer 是唯一的写入口**：每个 action 同时维护 `srs` 卡片、`attempts` 作答记录、`mistakes` 错题档案、`stats` 每日统计与 `updatedAt`，保证四者一致。`recordExercise` 会把练习题结果当作一次 `good/again` 排程，因此练习与闪卡共享同一条记忆曲线。
- **持久化**：`data` 变化后 250ms 防抖写入 localStorage；`beforeunload` / `visibilitychange(hidden)` 时强制落盘；写入失败（配额满/隐私模式）通过 toast 提示且不刷屏。
- **主题**：`SET_THEME` 写回数据，同时把 `data-theme` 写到 `<html>` 并更新 `theme-color`。
- **Toast**：`actions.toast()` 是视图层唯一允许的提示通道，错误停留更久。
- **失败安全**：启动时 `loadData()` 返回的首读警告（损坏数据/不可用）只提示一次。

### 2.3 领域层

| 模块 | 职责 | 关键导出 |
| --- | --- | --- |
| `srs.ts` | 间隔重复排程 | `createCard`、`gradeCard(card, grade, now)`、`isDue`、`previewInterval`、`masteryScore`、`GRADE_META`、`SRS_STATUS_META` |
| `session.ts` | 构建学习队列 | `buildStudyQueue(data, {mode, limit, newLimit, now})`、`countDue` |
| `stats.ts` | 派生统计与错题档案 | `getOverview`、`getWordProgressList`、`getWeakWords`、`getMistakeList`、`getAccuracy`、`computeStreak`、`getHeatmap`、`recordDailyEvent`、`pruneDaily` |
| `storage.ts` | 持久化与数据清洗 | `loadData`、`saveData`、`hydrateData`、`createInitialData`、`exportBackup`、`parseBackup`、`resetProgress`、`getStorageUsage` |
| `fallbackExercises.ts` | 离线出题 | `buildLocalExercises(words, mistakes, count)` |
| `llm/providers.ts` | 传输层 | `chatComplete`、`testLLMConnection`、`hasUsableLLMConfig`、`resolveEndpoint`、`mapHttpStatus` |
| `llm/prompts.ts` | 提示词 | `buildMessages`、`SYSTEM_PROMPT`、`PROMPT_VERSION` |
| `llm/generate.ts` | 编排与校验 | `generateExercises(request)`、`extractJsonCandidate`、`parseExercises` |
| `utils.ts` | 通用工具 | 时间/日期、`shuffle`、`sample`、`normalizeAnswer`、`speak`、`cx`、`isLocalEndpoint` |

所有领域函数都接受可选的 `now` 参数，便于测试与确定性排程。

### 2.4 数据层

- `src/types.ts`：`Word`、`SrsCard`、`Attempt`、`Mistake`、`Exercise`、`AppData`、`LLMSettings`、`DailyStat` 等全部领域类型与公共常量 `DATA_VERSION`。
- `src/data/wordbank.ts`：`SEED_WORDS: WordInput[]`（190 条），首次启动时由 `createInitialData` 生成 `Word` + 初始卡。
- 数据格式与兼容规则见 [版本规格 §4](version-spec.md#4-数据格式版本dataversion)。

---

## 3. 关键数据流

### 3.1 启动

```
main.tsx → App(ErrorBoundary + AppProvider) → Shell(hash 路由)
                       └─ loadData(): localStorage 读取 → hydrateData 清洗
                          → 失败时备份 corrupt → createInitialData 降级 + 一次性 toast
```

### 3.2 闪卡学习

```
StudyView: buildStudyQueue(data)            // 开始本轮时构建一次
  → 用户翻面 → gradeWord(wordId, grade)
     → reducer GRADE_WORD:
         gradeCard(card, grade)              // 新卡片排程
         attempts.unshift(...)               // 作答记录
         mistakes[wordId] = 更新错误次数/连对
         stats.daily[今天] 累加 reviewed/correct/wrong/learned
  → 「再来一轮」重新构建队列（可能为空 → 空状态）
```

### 3.3 错题特训（LLM 路径）

```
DrillView setup: getMistakeList(data) → 选词 / 题量 / 难度 / 引擎
  → generateExercises({
       targets: [{ word, wrongCount, correctStreak, srsStatus,
                   lastExerciseType, lastMistakeAt, recentAccuracy }],
       count, difficulty, settings, signal, onProgress })
     ├─ buildMessages(request) → chatComplete(settings, messages)
     │    ├─ OpenAI 兼容：POST {baseUrl}/chat/completions（json 模式，400/422 自动降级）
     │    └─ Anthropic：POST {baseUrl}/messages（system 拆分 + 浏览器直连头）
     ├─ extractJsonCandidate → parseExercises → sanitizeExercise × N（丢弃非法项）
     └─ 成功：Exercise[]（source='llm'）
     └─ 失败：LLMError(code) → UI 展示原因 → 重试 / 改用本地题库
  → quiz: 逐题作答 → 判分（normalizeAnswer 比对）
     → recordExercise({wordId, correct, exerciseType, source, prompt})
        → reducer RECORD_EXERCISE（与闪卡同一套卡片/错题/统计更新）
  → result: 汇总本轮答案
```

### 3.4 离线兜底路径

`buildLocalExercises(words, mistakes, count)`：错词加权选题 → 单词内混排 choice/fill → 干扰项偏好同词性、排除近义释义防「双解」 → 例句按屈折形式挖空并给出等价答案。永不抛错，词库不足时返回更少题目（可为 0）。

### 3.5 数据管理

- 导出：`exportBackup(data, {includeApiKey:false})` → Blob 下载（默认清空 Key）。
- 导入：`parseBackup(text)` → `hydrateData(..., {requireWords:true})` → `importBackup`（覆盖词库/进度，保留当前 Key）。
- 清空进度 `resetProgress`：重置卡片/作答/错题/统计，保留词库与设置。
- 恢复初始 `RESET_ALL`：回到内置词库，保留 `settings` 与 `theme`。

---

## 4. LLM 层细节

### 4.1 传输层（`providers.ts`）

- **端点解析** `resolveEndpoint`：去尾部斜杠；已含 `/chat/completions` 或 `/messages` 不重复拼接；只填主机时按协议补 `/v1/...`；填到 `/v1` 时补端点路径。
- **请求头**：OpenAI 兼容 `Authorization: Bearer`（Key 为空时不发送，兼容 Ollama）；Anthropic `x-api-key`、`anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`。
- **超时与取消**：默认 90s（连接测试 20s），与调用方 `AbortSignal` 组合；区分「调用方取消 → `aborted`」与「超时 → `timeout`」。
- **错误映射** `mapHttpStatus`：401/403 → `auth`，429 → `rate-limit`，5xx → `server`，其他非 2xx → `http`（附服务端错误摘要），网络异常 → `network`。

### 4.2 提示词（`prompts.ts`）

系统提示定义角色、四类题型、可判分约束（选项 3~4、答案精确、填空含 `____`）、禁用的「以上都对」类选项、每词最多 2 题、中文解析 ≤120 字、纯 JSON 输出。用户提示携带错词清单（含错因历史）与三档难度策略。`PROMPT_VERSION = v1`。

### 4.3 编排与校验（`generate.ts`）

1. `onProgress('正在整理错词…')` → `chatComplete` → `onProgress('正在校验题目…')`；
2. JSON 容错：去代码围栏、按「最先出现的结构」截取对象或数组；
3. 逐题校验：`wordId ∈ targets`、题型合法、选择题选项 3~4 且互不重复、答案精确匹配或归一化唯一修正（再容忍 `A.` 序号）、填空必须含下划线且答案非空、长度上限、难度 clamp；
4. 选项打乱、去重（`wordId + type + 归一化 prompt`）、每词 ≤2 题、总量 ≤ `count`；
5. 无任何合法题 → 抛 `LLMError('parse' | 'empty')`，交由 UI 重试或回退本地题库。

---

## 5. 存储与一致性

- 键：`deepword:data:v1`；损坏备份键：`deepword:data:v1:corrupt:<timestamp>`（原文本，永不自动删除）。
- 写入是**整体覆盖**（`JSON.stringify(AppData)`），无增量写，因此不存在部分更新不一致；代价是每次写都要序列化整个对象（量级：3000 条作答 + 1 万词时约数 MB，接近 5MB 配额时由 UI 提示导出备份）。
- 读取顺序：`JSON.parse` → `hydrateData`（结构性错误抛出）→ `loadData` 捕获 → 备份 + 示例数据 + 警告。
- 已知边界：同一浏览器多标签页同时编辑，以最后写入为准（未监听 `storage` 事件做跨标签同步）。

---

## 6. 目录与关键文件

```
src/
├── main.tsx / App.tsx / App.css     入口、hash 路由、外壳、错误边界
├── types.ts                          领域类型唯一来源
├── state/AppState.tsx                全局状态、写操作、持久化、Toast
├── lib/{srs,session,stats,storage,utils,fallbackExercises}.ts + *.test.ts
├── lib/llm/{types,providers,prompts,generate,index}.ts + llm.test.ts
├── data/wordbank.ts                  内置词库（190 词）
├── components/
│   ├── Dashboard.tsx                 「今日」
│   ├── study/{StudyView,Flashcard,StudySummary}.tsx 「学习」
│   ├── drill/{DrillView,SetupStage,GeneratingStage,QuizStage,ResultStage,FailureStage,meta}.tsx 「错题特训」
│   ├── WordbookView.tsx              「词库」
│   ├── SettingsView.tsx              「设置」
│   ├── Sidebar.tsx                   导航与主题
│   └── ui/{Modal,ConfirmDialog,ToastStack,icons}.tsx
└── styles/{tokens,base,ui}.css       设计系统
```

## 7. 测试策略

- **单元测试（Vitest，node 环境）**：全部领域层纯函数 + LLM 请求构造/解析/校验（`fetch` 被 mock，不产生真实网络请求）。
- **浏览器端人工/脚本化验收**：headless Chrome（CDP）驱动真实页面完成完整流程（学习、特训、词库、设置、备份、暗色、390px），并用契约一致的 mock LLM 服务验证 OpenAI 与 Anthropic 两条真实 HTTP 链路、失败回退与 Key 不泄漏。
- **构建门禁**：`pnpm typecheck && pnpm test && pnpm build` 全绿才可发布（见版本规格 §6）。
