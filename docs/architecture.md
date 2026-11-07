# 架构说明（Architecture）

「词渊 DeepWord」是**本地优先**的单页应用：业务数据只保存在浏览器 `localStorage`，所有学习逻辑在浏览器内运行。AI 请求不再由浏览器直接连接厂商，而是发往**同源的本地代理**（`POST /api/llm/forward`），由零依赖的 Node 进程转发到厂商。

因此「无后端」指的是**没有云端服务、账号与遥测**；AI 功能需要本机起一个进程——开发时由 Vite middleware 提供 `/api`，生产时由 `server/index.mjs` 同时托管 `dist/` 与 `/api`。

---

## 1. 设计原则

1. **本地优先**：没有云端服务器、账号与遥测；数据在本机；代理只转发、不存 Key；代理未启动时 AI 功能不可用，练习自动回退本地题库。
2. **单一数据源**：整个应用状态是一个 `AppData` 对象，由 `AppState` 用 `useReducer` 维护，任何写操作都必须经过 action；组件不直接读写 `localStorage`。
3. **纯函数化的领域层**：排程、队列、统计、存储清洗、provider 派生、本地出题、LLM 解析与校验都是可在 Node 中单测的纯函数；React 组件只负责渲染和交互。
4. **模型输出不可信**：LLM 返回内容一律经过 JSON 提取 + 逐题严格校验，不合法即丢弃；题干与解析按纯文本渲染。
5. **同源转发**：浏览器只认识 `POST /api/llm/forward`（以及模型列表的 GET 转发）；真正的厂商地址由代理拨号。浏览器不需要 CORS，也不再携带 Anthropic 的浏览器直连豁免头。
6. **契约先行**：`src/types.ts` 是所有领域类型的唯一来源；LLM 请求/响应类型在 `src/lib/llm/types.ts`；本地代理的线协议见 `docs/phase-a-contract.md`。

---

## 2. 分层结构

```
┌──────────────────────────────────────────────────────────────┐
│ 视图层  src/components/**                                     │
│  Dashboard / study/ / drill/ / WordbookView / SettingsView    │
│  providers/：ProviderList、ProviderEditor、ModelListDialog     │
│  ui/：Modal、ConfirmDialog、ToastStack、icons                 │
├──────────────────────────────────────────────────────────────┤
│ 状态层  src/state/AppState.tsx                                │
│  useReducer(AppData) + AppActions + Toast + 持久化副作用     │
├──────────────────────────────────────────────────────────────┤
│ 领域层  src/lib/                                              │
│  srs.ts  stats.ts  fallbackExercises.ts                      │
│  storage.ts  providerModel.ts  utils.ts                      │
│  practice.ts  practiceRound.ts  mastery.ts                   │
│  weakness.ts  rounds.ts  feedback.ts  tts.ts                 │
│  llm/{providers,prompts,generate,feedbackPrompts,types,index}│
├──────────────────────────────────────────────────────────────┤
│ 数据层  src/types.ts（领域类型）  src/data/wordbank.ts        │
│  browser localStorage（键 deepword:data:v2；v1 仅迁移来源）   │
└───────────────────────────┬──────────────────────────────────┘
                            │ fetch('POST /api/llm/forward')
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ 本地代理层  server/                                           │
│  proxy.mjs：/api/health、/api/llm/forward（零依赖）           │
│  dev：Vite middleware；prod：index.mjs 托管 dist + /api       │
└───────────────────────────┬──────────────────────────────────┘
                            │ http(s)，头白名单，不跟随重定向
                            ▼
              厂商 API（OpenAI 兼容 / Anthropic）
```

### 2.1 视图层

- 每个页面是一个**受控视图**，接收 `ViewProps { navigate(view) }`，通过 `useApp()` 读取 `data`、调用 `actions`。
- 页面之间零共享可变状态：需要派生的数据（队列、统计、弱词）在渲染时用领域层纯函数即时计算（`useMemo`），或按交互时机构建一次（如一轮的选词与题目在「开始一轮」时构建）。
- 设置页的 provider 展示拆到 `components/providers/`：`ProviderList`（列表 + 当前使用切换）、`ProviderEditor`（本地草稿表单 + 连通性测试）、`ModelListDialog`（拉取模型列表、勾选白名单）、`draft.ts`（profile ⇄ draft ⇄ LLMSettings 的拍平与还原）。
- 样式分两级：全局设计系统（`styles/tokens.css` 变量、`styles/base.css` 排版、`styles/ui.css` 共享组件类）+ 页面目录内的同名 CSS。所有颜色/字体/间距/动效均走 CSS 变量，暗色主题只需覆盖 `[data-theme='dark']` 下的变量。
- 外壳 `App.tsx` 负责 hash 路由、错误边界、跳转链接与页脚；`Sidebar` 负责导航、连续天数、主题切换。

### 2.2 状态层（`AppState.tsx`）

- **状态**：`data: AppData`（`useReducer`）、`toasts`。
- **Action**：`GRADE_WORD`、`RECORD_EXERCISE`、`ADD_WORD`、`UPDATE_WORD`、`DELETE_WORD`、`IMPORT_WORDS`、`ADD_PROVIDER`、`UPDATE_PROVIDER`、`DELETE_PROVIDER`、`SET_ACTIVE_PROVIDER`、`SET_THEME`、`IMPORT_DATA`、`RESET_ALL`、`CLEAR_PROGRESS`，以及 Phase B 的 `SET_SESSION`、`SET_PRACTICE_SETTINGS`、`MARK_MASTERED`、`UNMARK_MASTERED`、`FLAG_REVIEW_PRIORITY`、`CLEAR_REVIEW_PRIORITY`。
- **Reducer 是唯一的写入口**：每个 action 同时维护 `srs` 卡片、`attempts` 作答记录、`mistakes` 错题档案、`stats` 每日统计、`providers` / `activeProviderId` 与 `updatedAt`，保证一致。`recordExercise` 会把练习题结果当作一次 `good/again` 排程，因此练习作答与（数据层保留的）闪卡自评共享同一条记忆曲线。
- **provider 写操作**：`addProvider(draft)`（上限 20 份，返回 `{ok, message, id?}`）、`updateProvider(id, draft)`、`deleteProvider(id)`（删除当前配置后回退列表首份）、`setActiveProvider(id | null)`。`data.settings` 已移除；任何需要 LLMSettings 的地方都用 `resolveActiveLLMSettings(data)` 从当前配置派生。
- **Phase B 写操作**：`setPracticeSession(session)`（一轮的阶段、题目、逐题结果与讲解）、`setPracticeSettings(patch)`（练习设置局部更新，tts 整体回写）、`markMastered(wordId, source)` / `unmarkMastered(wordId)`（掌握标记与卡片状态同步）、`flagReviewPriority(wordId)` / `clearReviewPriority(wordId)`（闪卡「不认识」的复习优先）。`RECORD_EXERCISE` 额外接收 `skill` / `verdict` / `latencyMs` / `roundId` / 讲解字段，并在满足掌握判定时自动写入 `data.mastery`。
- **持久化**：`data` 变化后 250ms 防抖写入 localStorage（v2 键）；`beforeunload` / `visibilitychange(hidden)` 时强制落盘；写入失败（配额满/隐私模式）通过 toast 提示且不刷屏。`providers` / `activeProviderId` / `practice` / `session` / `mastery` / `reviewPriority` 与词库、卡片、作答、错题、统计一起随整个 `AppData` 落盘。
- **主题**：`SET_THEME` 写回数据，同时把 `data-theme` 写到 `<html>` 并更新 `theme-color`。
- **Toast**：`actions.toast()` 是视图层唯一允许的提示通道，错误停留更久。
- **失败安全**：启动时 `loadData()` 返回的首读警告（损坏数据/不可用）只提示一次。

### 2.3 领域层

| 模块 | 职责 | 关键导出 |
| --- | --- | --- |
| `srs.ts` | 间隔重复排程 | `createCard`、`gradeCard(card, grade, now)`、`isDue`、`previewInterval`、`masteryScore`、`GRADE_META`、`SRS_STATUS_META` |
| `stats.ts` | 派生统计与错题档案 | `getOverview`、`getWordProgressList`、`getWeakWords`、`getMistakeList`、`getAccuracy`、`computeStreak`、`getHeatmap`、`recordDailyEvent`、`pruneDaily` |
| `storage.ts` | 持久化、迁移与数据清洗 | `loadData`、`saveData`、`hydrateData`、`migrateV1ToV2`、`createInitialData`、`exportBackup`、`parseBackup`、`resetProgress`、`resetWordsToSeed`、`getStorageUsage`、`clearStoredData`、`makeWord`、`normalizeWord` |
| `providerModel.ts` | provider 配置与派生 | `VENDOR_OPTIONS`、`VENDOR_PRESETS`、`inferVendorFromBaseUrl`、`vendorLabel`、`toLLMSettings`、`findActiveProvider`、`resolveActiveLLMSettings`、`providerSummaryText`、`checkBaseUrl`、`legacySettingsToProfile`、`preserveApiKeys`、`normalizeAppShape`、`createInitialProviders` |
| `fallbackExercises.ts` | 离线出题（错题特训） | `buildLocalExercises(words, mistakes, count)` |
| `practice.ts` | 6 技能本地出题（学习流程） | `SKILLS`、`SKILL_META`、`buildQuestions`、`buildMixedQuestions`、`pickSkills`、`checkAnswer`、`isTranslation`、`skillLabel` |
| `practiceRound.ts` | 一轮的状态机（纯函数） | `createSession`、`confirmGate`、`rejectGate`、`nextNewWordGate`、`startNewStage`、`startReviewStage`、`applyAnswer`、`advanceQuestion`、`isRoundComplete`、`answeredInStage`、`summarizeSession`、`newQuestionCount`、`reviewQuestionCount`、`hasResumableSession` |
| `mastery.ts` | 掌握判定 | `MASTERY_RULES`、`evaluateMastery(data, wordId, now)`、`isMastered` |
| `weakness.ts` | 薄弱分析（6 维度） | `getSkillStats`、`getWeaknessReport`、`scoreWordWeakness` |
| `rounds.ts` | 一轮选词 | `countAvailable`、`pickNewWord`、`pickReviewWords`、`planRound`、`scoreReviewWord`、`MIN_NEW_WORDS`、`MAX_NEW_WORDS` |
| `feedback.ts` | AI 讲解与互译判分 | `localAnswerFeedback`、`streamAnswerFeedback`、`localTranslationGrade`、`streamTranslationGrade`、`parseFeedbackImprovement`、`parseTranslationVerdict`、`encouragement`、`EXPLANATION_MAX` |
| `tts.ts` | 浏览器语音 | `isSpeechSupported`、`listEnglishVoices`、`hasEnglishVoice`、`pickEnglishVoice`、`speak`、`cancelSpeech`、`useEnglishVoices` |
| `llm/providers.ts` | 传输层（经本地代理） | `chatComplete`、`streamChat`、`fetchModels`、`testLLMConnection`、`hasUsableLLMConfig`、`resolveEndpoint`、`buildThinkingParams`、`buildRequestHeaders`、`mapHttpStatus` |
| `llm/prompts.ts` | 提示词 | `buildMessages`、`SYSTEM_PROMPT`、`PROMPT_VERSION` |
| `llm/feedbackPrompts.ts` | 讲解与判分提示词 | `buildAnswerFeedbackMessages`、`buildTranslationMessages`、`FEEDBACK_PROMPT_VERSION` |
| `llm/generate.ts` | 编排与校验 | `generateExercises(request)`、`extractJsonCandidate`、`parseExercises` |
| `utils.ts` | 通用工具 | 时间/日期、`shuffle`、`sample`、`normalizeAnswer`、`speak`、`formatLatency`、`cx`、`isLocalEndpoint` |

所有领域函数都接受可选的 `now` 参数，便于测试与确定性排程。

### 2.4 数据层

- `src/types.ts`：`Word`、`SrsCard`、`Attempt`、`Mistake`、`Exercise`、`ProviderProfile`、`Vendor`、`ThinkingMode`、`PracticeSettings`、`PracticeSessionState`、`PracticeResult`、`MasteryRecord`、`AppData` 等全部领域类型，以及公共常量 `DATA_VERSION = 2`、`MAX_PROVIDERS = 20`、`MAX_MODELS_PER_PROVIDER = 300`、`DEFAULT_PRACTICE_SETTINGS`。
- `AppData` 的 Phase B 扩展（全部可缺省，读取层补默认值，因此 `DATA_VERSION` 保持 `2`）：
  - `mastery?: Record<wordId, MasteryRecord>`——掌握标记，存在即已掌握（永久出队，可手动取消）；
  - `reviewPriority?: Record<wordId, number>`——闪卡「不认识」的复习优先标记，值为标记时间；
  - `session?: PracticeSessionState | null`——当前一轮的阶段、题目、当前下标、逐题结果与讲解；
  - `Attempt` 追加可选字段 `skill` / `latencyMs` / `verdict` / `roundId` / `aiFeedback` / `aiImprovement` / `aiStatus`。
- `src/data/wordbank.ts`：`SEED_WORDS: WordInput[]`（190 条），首次启动时由 `createInitialData` 生成 `Word` + 初始卡 + 1 份默认 provider + 默认练习设置。
- 数据格式与兼容规则见 [版本规格 §4](version-spec.md#4-数据格式版本dataversion)。

---

## 3. 关键数据流

### 3.1 启动

```
main.tsx → App(ErrorBoundary + AppProvider) → Shell(hash 路由)
                       └─ loadData():
                          ① 读 deepword:data:v2 → hydrateData 清洗
                          ② 无 v2 时读 deepword:data:v1 → hydrateData 迁移 v1→v2 → 写回 v2（v1 保留）
                          ③ 读取失败 → 备份 corrupt → createInitialData 降级 + 一次性 toast
```

### 3.2 学习流程（Phase B）

```
StudyView（学习 tab）
  → 开始一轮: planRound(data, practice)                // 新词 N 个（默认 1）+ 复习 4~6 词（按薄弱度）
     → createSession(plan)                             // stage='gate'，写入 data.session
  → 闸门（每个新词各走一遍）:
     点「掌握」→ confirmGate(session)                   // gate='confirm'，闪卡翻面
        → 确认 → actions.markMastered(wordId,'manual')  // reducer 写 data.mastery + 卡片置 mastered
                   → nextNewWordGate(session)           // 还有新词 → 下一个闸门；没有 → 进入复习阶段
        → 再想想 → rejectGate(session, word, ctx)
     点「不认识」→ rejectGate → startNewStage → buildQuestions(word, …)   // 6 技能本地出题
  → 出题:
     本地题 → checkAnswer(exercise, response)
     互译题 → streamTranslationGrade(...)              // 流式三档判分，失败降级本地
     答错 → streamAnswerFeedback(...)                  // 流式讲解，失败降级 localAnswerFeedback
     → actions.recordExercise({ skill, verdict, latencyMs, aiFeedback, roundId })
        → reducer RECORD_EXERCISE：写 attempts / mistakes / stats
           → evaluateMastery(...) 满足四条规则时自动写 data.mastery
     → applyAnswer(session, …) 写回逐题结果（讲解入库，便于小结回看）
  → 阶段推进: 下一题 → advanceQuestion；本阶段答完
     新词阶段 → nextNewWordGate(session) 或 startReviewStage(session, reviewWords, ctx) → buildMixedQuestions(…)
     复习阶段 → session.stage='done' → 小结 → 「继续」→ planRound 下一轮
  → 中途退出：data.session 持久化，刷新后按 stage 恢复

StudyView（闪卡 tab）
  → 逐个自查已学词:
     点「不认识」→ actions.flagReviewPriority(wordId)   // 下一轮复习优先
     点「掌握」→ 翻面 → 确认 → actions.markMastered(wordId,'manual')
     已掌握 → actions.unmarkMastered(wordId)            // 回到复习队列
```

**数据流（一次判分的完整链路）**

```
答一题
  → 判分（本地 checkAnswer / AI 三档判分）
  → actions.recordExercise({ wordId, correct, exerciseType, source, prompt,
                             skill, verdict, latencyMs, aiFeedback, aiImprovement,
                             aiStatus, roundId })
     → reducer RECORD_EXERCISE
        ├─ attempts.unshift(...)        // 带 skill / roundId / verdict / aiFeedback 的作答记录
        ├─ mistakes[wordId]             // 错题档案（错误次数、连对、最近错因与题型）
        ├─ srs[wordId]                  // 卡片排程（good / again）
        ├─ stats.daily[今天]            // reviewed / correct / wrong / learned
        └─ evaluateMastery(data, wordId)  // 满足四条规则 → 写 data.mastery
  → applyAnswer(session, …)            // 逐题结果与讲解留在会话里（小结回看）
  → 薄弱分析与掌握判定**现算**：getWeaknessReport(data) / evaluateMastery(data, wordId)
     只读 attempts 与 mastery，不另存统计表
```

### 3.3 旧版闪卡 SRS（排程算法保留，学习队列模块已移除）

- 1.1.0 起学习页只走 Phase B 的一轮流程；**旧的「构建学习队列 + 三阶段学习页」模块（`src/lib/session.ts`）已删除**，不再有「扉页 → 四档自评 → 成绩单」这条路径。
- `src/lib/srs.ts` 的 SM-2 变体排程**仍保留在数据层**：卡片由 `RECORD_EXERCISE` 判分驱动（对 = `good`、错 = `again`），用于卡片进度、掌握度分布与统计。
- `GRADE_WORD` action 与四档自评（`again` / `hard` / `good` / `easy`）仍在状态层保留，但 1.1.0 的界面不再调用它；闪卡 tab 改为「不认识 / 掌握」两档自查。

### 3.4 provider 管理与模型列表

```
SettingsView 列表/表单:
  ProviderEditor 维护本地草稿 ProviderDraft（不直接写 data）
  → 保存: actions.addProvider(draft) / updateProvider(id, draft)
      → reducer ADD_PROVIDER / UPDATE_PROVIDER 写入 data.providers
  → 设为当前: actions.setActiveProvider(id)
      → reducer SET_ACTIVE_PROVIDER 写 activeProviderId
  → 250ms 防抖把整个 AppData 写入 deepword:data:v2
出题/判分读取: resolveActiveLLMSettings(data) → LLMSettings

模型列表: ProviderEditor「拉取模型列表」
  → ModelListDialog → fetchModels(draftToLLMSettings(draft))
      → 经 /api/llm/forward GET 转发到 {base}/models（Ollama 失败回落 /api/tags）
  → 勾选后 onConfirm(models) 写回草稿白名单
```

### 3.5 错题特训（LLM 路径）

```
DrillView setup: getMistakeList(data) → 选词 / 题量 / 难度 / 引擎状态
  → generateExercises({
       targets: [{ word, wrongCount, correctStreak, srsStatus,
                   lastExerciseType, lastMistakeAt, recentAccuracy }],
       count, difficulty, settings: resolveActiveLLMSettings(data),
       signal, onProgress })
     ├─ buildMessages(request) → chatComplete(settings, messages)
     │    └─ 浏览器 fetch('POST /api/llm/forward')
     │         └─ 本地代理 → 厂商
     │              OpenAI 兼容：{base}/chat/completions（json 模式，400/422 自动降级）
     │              Anthropic：{base}/v1/messages（system 拆分；只填厂商前缀时自动补齐 /v1）
     ├─ extractJsonCandidate → parseExercises → sanitizeExercise × N（丢弃非法项）
     └─ 成功：Exercise[]（source='llm'）
     └─ 失败：LLMError(code) → UI 展示原因 → 重试 / 改用本地题库
  → quiz: 逐题作答 → 判分（normalizeAnswer 比对）
     → recordExercise({wordId, correct, exerciseType, source, prompt})
        → reducer RECORD_EXERCISE（与闪卡同一套卡片/错题/统计更新）
  → result: 汇总本轮答案
```

`streamChat` 是 Phase A 的流式基建（SSE 双协议解析 + `onToken`），当前 drill 出题仍使用一次性 `chatComplete`。

### 3.6 离线兜底路径

`buildLocalExercises(words, mistakes, count)`：错词加权选题 → 单词内混排 choice/fill → 干扰项偏好同词性、排除近义释义防「双解」 → 例句按屈折形式挖空并给出等价答案。永不抛错，词库不足时返回更少题目（可为 0）。

### 3.7 数据管理

- 导出：`exportBackup(data, {includeApiKey:false})` → `version=2` 的 Blob 下载（默认清空每份 provider 的 Key）。
- 导入：`parseBackup(text)` → `hydrateData(..., {requireWords:true})`（v1 自动迁移）→ `importBackup`（覆盖词库/进度/配置，缺失的 Key 按 Base URL 继承本机配置）。
- 清空进度 `resetProgress`：重置卡片/作答/错题/统计，保留词库、provider 配置与练习设置。
- 恢复初始 `RESET_ALL`：回到内置词库，保留 `providers` / `activeProviderId` / `practice` 与主题。

---

## 4. LLM 层细节

### 4.1 传输层（`providers.ts`）

- **统一出口**：所有真实请求都发往同源 `POST /api/llm/forward`，payload 为 `{url, method, headers, body, stream}`；浏览器不再直接连接厂商域名，也不需要 CORS。
- **端点解析** `resolveEndpoint`：去尾部斜杠；已含 `/chat/completions` 或 `/messages` 不重复拼接；只填主机时按协议补 `/v1/...`；OpenAI 兼容填到版本层（如 `/v1`）时补 `/chat/completions`。Anthropic 填到版本层（`/v1`、`/v1beta`）时只补 `/messages`，只填主机或厂商前缀（火山方舟 `/api/coding`、DeepSeek `/anthropic` 等）时补 `/v1/messages`（Anthropic SDK 约定）。模型列表同理：OpenAI 兼容 `{base}/models`，Anthropic 版本层补 `{base}/models`、厂商前缀补 `{base}/v1/models`。
- **请求头**：OpenAI 兼容 `Authorization: Bearer`（Key 为空时不发送，兼容 Ollama）；Anthropic 官方主机 `x-api-key` + `anthropic-version: 2023-06-01`，非官方兼容网关（火山方舟 Ark、DeepSeek 等）额外携带 `Authorization: Bearer`（部分网关的模型列表只认 Bearer）。**不再发送** `anthropic-dangerous-direct-browser-access`，也不发送 `Origin` / `Cookie`（代理会剥离）。
- **思考参数**：按 `settings.vendor` 白名单注入（见 §4.2 表）；`settings.thinkingMode === 'off'` 或调用方 `noThink` 时生效。上游 400/422 且错误文本点名 `thinking` / `reasoning_effort` / `enable_thinking` 时，去掉思考参数重试一次（JSON 请求与流式请求都覆盖）。
- **JSON 模式降级**：OpenAI 兼容带 `response_format:{type:'json_object'}`；上游 400/422 不支持时去掉后重试。
- **超时与取消**：客户端默认 **90s 总超时**（连通性测试 / 模型列表 20s），与调用方 `AbortSignal` 组合；代理侧另有「连接 20s、总 90s」双计时。**超过 90s 会被中止**：流式响应可能被截断，已收到的 token 拼接不完整，最终抛出 `timeout`，UI 提示重试或改用本地题库。
- **错误映射**：代理自身错误 JSON（`{"error":{"code":"bad-request|network|timeout"}}` → `config` / `network` / `timeout`）；上游 401/403 → `auth`，429 → `rate-limit`，5xx → `server`，其他非 2xx → `http`（附服务端摘要），网络异常 → `network`，调用方取消 → `aborted`。
- **连通性测试** `testLLMConnection`：`max_tokens: 1` + `temperature: 0` + 强制关闭思考；只看响应是否成功，**空内容也算成功**；永不抛错，失败返回中文可操作提示。
- **模型列表** `fetchModels`：永不抛错，失败返回 `warning` + 空列表。解析三种形状——OpenAI 兼容 `data[].id`、Anthropic `data[].id/display_name/lifecycle/max_tokens`、Ollama 原生 `models[].name`；`vendor === 'ollama'` 时 `/models` 失败回落 `{origin}/api/tags`。

### 4.2 思考参数映射

| vendor | 关闭思考参数 |
| --- | --- |
| anthropic / deepseek / glm / volcengine（火山方舟） | `thinking:{type:'disabled'}` |
| qwen / siliconflow | `enable_thinking:false` |
| openai | `reasoning_effort:'minimal'` |
| ollama | `reasoning_effort:'none'` |
| kimi | `thinking:{type:'disabled'}`（K3 系列改 `reasoning_effort:'low'`） |
| minimax / custom / 缺省 | 不发 |

### 4.3 SSE 流式（`streamChat`）

- 支持 OpenAI `data:` delta 与 Anthropic `content_block_delta` 两种协议；Anthropic 用 `event:` / `data:` 行，OpenAI 以 `data: [DONE]` 结束。
- 逐行解析器带缓冲，兼容任意 chunk 边界与 CRLF；SSE 注释行（`:` 开头）忽略；`id` / `retry` 字段忽略。
- 只取正文增量，`reasoning_content` / `thinking_delta` 一律忽略。
- 上游若把流式请求降级为普通 JSON（`application/json`），按一次性文本兼容。
- 上游错误 event 映射为带 code 的 `LLMError`；阅读中断/超时统一映射。

### 4.4 提示词（`prompts.ts`）

系统提示定义角色、四类题型、可判分约束（选项 3~4、答案精确、填空含 `____`）、禁用的「以上都对」类选项、每词最多 2 题、中文解析 ≤120 字、纯 JSON 输出。用户提示携带错词清单（含错因历史）与三档难度策略。`PROMPT_VERSION = v1`。

### 4.5 编排与校验（`generate.ts`）

1. `onProgress('正在整理错词…')` → `chatComplete` → `onProgress('正在校验题目…')`；
2. JSON 容错：去代码围栏、按「最先出现的结构」截取对象或数组；
3. 逐题校验：`wordId ∈ targets`、题型合法、选择题选项 3~4 且互不重复、答案精确匹配或归一化唯一修正（再容忍 `A.` 序号）、填空必须含下划线且答案非空、长度上限、难度 clamp；
4. 选项打乱、去重（`wordId + type + 归一化 prompt`）、每词 ≤2 题、总量 ≤ `count`；
5. 无任何合法题 → 抛 `LLMError('parse' | 'empty')`，交由 UI 重试或回退本地题库。

### 4.6 Phase B 的 AI 反馈链路（讲解与互译判分）

```
StudyView 判分
  → 答错: streamAnswerFeedback({ word, exercise, response }, settings, { onToken })
  → 互译: streamTranslationGrade({ word, exercise, response }, settings, { onToken, onVerdict })
     → buildAnswerFeedbackMessages / buildTranslationMessages（llm/feedbackPrompts.ts，FEEDBACK_PROMPT_VERSION = v1）
     → streamChat(settings, messages, { noThink: true, maxTokens: 600, timeoutMs: 30_000, onToken })
        → 浏览器 fetch('POST /api/llm/forward')      // 与出题同一条同源链路
           → 本地代理（server/proxy.mjs）→ 厂商
              → SSE 逐段回传：OpenAI `data:` delta / Anthropic `content_block_delta`
     → 互译协议：首行 `VERDICT: perfect|good|poor`，解析到即回调 onVerdict，正文继续流式输出
  → 任何失败（未配置 / 网络 / 超时 / 取消 / 协议解析失败）→ 本地降级，绝不抛错
     → localAnswerFeedback / localTranslationGrade（status = 'local-fallback'）
```

- **no-think**：讲解与判分都带 `noThink: true`（按厂商注入关闭思考参数），避免模型输出思考内容污染讲解正文。
- **纯文本输出**：讲解正文去掉 markdown 围栏与 HTML 标签，按纯文本渲染；不解析 JSON。
- **Key 脱敏**：输出里若出现当前配置的 API Key 会被替换成「已隐藏」；流式增量还会保留 `key.length - 1` 的窗口，避免 Key 跨 chunk 拼出。
- **不阻塞作答**：降级路径不等待网络，讲解与判分结果照常写回作答记录。
- 讲解正文落库截断到 `EXPLANATION_MAX = 400` 字符；流式展示可见全文。

---

## 5. 存储与一致性

- 双键策略：主键 `deepword:data:v2`（`DATA_VERSION = 2`）；旧键 `deepword:data:v1` 仅作为迁移来源，迁移成功后保留不清除（供降级排查，保留一个 MINOR 版本周期）。`clearStoredData()` 同时删除两个键。
- 迁移：`loadData` 优先读 v2；无 v2 时读 v1 → `hydrateData` 自动识别 v1（`version === 1` 或「无 providers 但有 settings」）→ `migrateV1ToV2` 映射字段并补默认值 → 立即写回 v2。迁移是纯函数，不修改入参。
- 损坏备份键：`deepword:data:v2:corrupt:<timestamp>`（读旧键失败时为 `deepword:data:v1:corrupt:<timestamp>`，原文本，永不自动删除）。
- 写入是**整体覆盖**（`JSON.stringify(AppData)`），无增量写，因此不存在部分更新不一致；代价是每次写都要序列化整个对象（量级：3000 条作答 + 1 万词时约数 MB，接近 5MB 配额时由 UI 提示导出备份）。
- 读取顺序：`JSON.parse` → `hydrateData`（结构性错误抛出）→ `loadData` 捕获 → 备份 + 示例数据 + 警告。导入备份同样走 `hydrateData`，v1 自动迁移。
- 备份：`version=2`；每份 provider 的 `apiKey` 默认清空，`includeApiKey:true` 时保留；导入接受包装对象或裸 AppData，缺失 Key 按 Base URL 继承。
- 已知边界：同一浏览器多标签页同时编辑，以最后写入为准（未监听 `storage` 事件做跨标签同步）。

---

## 6. 目录与关键文件

```
server/
├── proxy.mjs                         本地代理：/api/health、/api/llm/forward、Vite 中间件、静态托管
├── proxy.test.mjs                    代理线协议单测
├── proxy.d.mts                       代理的 TS 声明（供 vite.config 引用）
└── index.mjs                         生产入口：托管 dist/ + /api（默认 127.0.0.1:8787）

src/
├── main.tsx / App.tsx / App.css     入口、hash 路由、外壳、错误边界
├── types.ts                          领域类型唯一来源
├── state/AppState.tsx                全局状态、写操作、持久化、Toast
├── lib/{srs,stats,storage,providerModel,utils,fallbackExercises}.ts + *.test.ts
├── lib/{practice,practiceRound,mastery,weakness,rounds,feedback,tts}.ts   学习流程（Phase B）
├── lib/llm/{types,providers,prompts,generate,feedbackPrompts,index}.ts + llm.test.ts
├── data/wordbank.ts                  内置词库（190 词）
├── components/
│   ├── Dashboard.tsx                 「今日」（含薄弱分析面板）
│   ├── study/{StudyView,QuestionCard,RoundSummary,FlashcardTab,Flashcard,types}.tsx 「学习」
│   ├── drill/{DrillView,SetupStage,GeneratingStage,QuizStage,ResultStage,FailureStage,meta}.tsx 「错题特训」
│   ├── WordbookView.tsx              「词库」
│   ├── SettingsView.tsx              「设置」（含练习设置卡片）
│   ├── providers/{ProviderList,ProviderEditor,ModelListDialog}.tsx + draft.ts
│   ├── Sidebar.tsx                   导航与主题
│   └── ui/{Modal,ConfirmDialog,ToastStack,icons}.tsx
└── styles/{tokens,base,ui}.css       设计系统
```

---

## 7. 测试策略

- **单元测试（Vitest，node 环境，共 384 用例 / 15 个测试文件）**：
  - Phase B 学习流程（124 用例）：
    - `practice.test.ts` 24 用例——6 技能本地出题、干扰项与去重、题量补齐、技能不可用时的回退、互译占比 ≤1/3、本地判分；
    - `practiceRound.test.ts` 26 用例——会话构造、闸门两分支、阶段推进、多新词轮次、按阶段计的完成判定、小结统计；
    - `rounds.test.ts` 20 用例——一轮选词（新词、复习候选、掌握词出队、薄弱排序、复习优先标记）；
    - `mastery.test.ts` 18 用例——掌握判定四条件与边界（连对、技能覆盖、14 天无错、轮次分布）；
    - `weakness.test.ts` 14 用例——6 维度正确率、最弱词、单词薄弱度、建议重点；
    - `feedback.test.ts` 22 用例——本地降级讲解与判分、流式协议解析、Key 脱敏、鼓励语；
  - 既有基线（260 用例）：
    - SRS 12、统计 11、工具与领域层纯函数；
    - 存储：`storage.test.ts` 34 用例，覆盖 v1→v2 迁移、v2 直读、损坏恢复、备份含/不含 Key、双键清理等；
    - LLM：`llm.test.ts` 146 用例 + `streamE2E.test.ts` 1 例（本地代理 + mock 上游的流式端到端）；`fetch` 被 mock、不产生真实网络请求；覆盖端点解析（含 Anthropic 厂商前缀补 `/v1/messages`）、请求体/头构造（含兼容网关 Bearer）、思考参数 13 组映射、400 去参重试、SSE 双协议解析、模型列表三形状与 Ollama 兜底、HTTP/代理错误映射、取消与超时；
    - 本地代理：`server/proxy.test.mjs` 14 用例，覆盖状态码/body 透传、SSE 分块逐块到达、头白名单与 `Origin/Referer/Cookie` 剥离、仅 http(s)、1 MB 上限 413、未知 `/api` 404、超时 504、客户端断开中止上游、非 `/api` 交回 Vite；
    - Provider 配置层 12、模型行合并 6、本地兜底出题（drill）24。
  - 统计口径：`pnpm test`（= `vitest run`）的 `Test Files` / `Tests` 汇总行；用例数随代码变动，以实际运行输出为准（1.1.0 文档同步时实测为 384）。
- **真实浏览器验收**：headless Chrome（CDP）驱动页面完成完整流程（学习、特训、词库、设置、备份、暗色、390px）；用契约一致的 mock LLM 服务经本地代理验证 OpenAI 与 Anthropic 两条真实 HTTP 链路、失败回退与 Key 不泄漏；`pnpm dev` 与 `pnpm build && pnpm start` 两条运行路径都要走一遍。
- **构建门禁**：`pnpm typecheck && pnpm test && pnpm build` 全绿才可发布（见版本规格 §6）。
