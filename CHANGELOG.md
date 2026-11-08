# 更新日志（CHANGELOG）

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 与 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

分类约定：`新增`（Added）、`变更`（Changed）、`迁移`（Migration）、`修复`（Fixed）、`移除`（Removed）、`安全`（Security）、`文档`（Docs）。

---

## [Unreleased]

### 文档（Docs）

- 新增 `docs/`：编码规范、版本迭代、文档更新约定；`AGENTS.md` 指向 docs。

### 变更（Changed）

- 项目更名为 **dpdp-word** / **DeepDeep Word**（中文：深深单词 / 肥鱼单词）；去掉「词渊」品牌文案。
- 技术标识集中到 `src/app/identity.ts`；本地键改为 `dpdp-word:data:v3`。
- 新增轻量 i18n（`en` 默认 + `zh-CN`），用户文案进 catalogs。
- 不再预置任何默认 LLM provider（含未验证的 OpenAI Base URL）；需用户自行添加并测试连接。
- 移除厂商「填入预设」（`VENDOR_PRESETS`）：Base URL / 模型需用户自行填写，厂商选择仅影响思考参数映射与 Base URL 推断。

### 迁移（Migration）

- 启动时若存在合法 `deepword:data:v3`，写入新键后清除全部 `deepword:*` 旧键；备份 `app`/`scheme` 改为 `dpdp-word` / `dpdp-word-backup`（仍接受旧备份标识）。

### 移除（Removed）

- 删除 `.workbuddy/`（含失效的 deepword-release skill）。

---

## [2.0.0] - 2026-11-08

绿场重写：按深模块分层重建代码树；**破坏性数据升级到 v3**。

**版本线**：应用 `2.0.0` · 数据格式 `DATA_VERSION = 3`（`deepword:data:v3`）· 讲解提示词 `FEEDBACK_PROMPT_VERSION = v1`

### 迁移（Migration）

- 本地键改为 `deepword:data:v3`；启动时清除 `deepword:data` / `v1` / `v2` 旧键并重新播种内置词库。
- **不提供** v1/v2 → v3 自动迁移；旧备份无法导入（仅接受 `version === 3` 的备份 JSON）。学习进度、作答与掌握标记需从零开始。

### 变更（Changed）

- 目录重组：`domain/`（纯领域）· `infra/`（storage / llm / tts）· `app/`（shell + 切片 store）· `features/`（dashboard / study / wordbook / settings）· `ui/`。
- 领域模型收紧：题型唯一维度为 `Skill`；`Question` 取代 `Exercise`；`Attempt` 仅练习作答；去掉 SRS 排程与 `reviewPriority`。
- 新词 / 复习划分改为「无作答记录 = 新词」「有作答且未掌握 = 复习」。
- 学习页：`useStudyController` 独占副作用，`StudyView` 只渲染阶段；保留闸门、点选即答、`retry`、AI 流式讲解与互译判分。
- LLM：拆成 `endpoints` / `vendors` / `forward`；移除 LLM 批量出题（`generateExercises`）与 `fallbackExercises`。
- 内置词库改为 `data/wordbanks/default.json`。

### 移除（Removed）

- SRS 驱动学习、`gradeWord`、闪卡 Attempt、`StudyMode` / `StudyItem`。
- Phase A 双轨 `ExerciseType` 与 LLM/本地兜底批量出题路径。
- v1 / v2 localStorage 兼容与迁移代码。

---

## [1.2.0] - 2026-11-07

### 移除（Removed）

- 学习页「闪卡」tab 与闪卡自查界面；学习页收敛为单页流程，新词闸门（词笺翻面）保留。
- 「错题特训」页面及其侧边栏入口、仪表盘跳转与引导文案；底层出题 / 统计模块与已有数据的兼容读取保留。

---

## [1.1.0] - 2026-11-07

Phase B：学习流程重构 —— 6 技能混合出题、闪卡闸门、薄弱分析、AI 讲解与互译判分、浏览器 TTS。

**版本线**：应用 `1.1.0` · 数据格式 `DATA_VERSION = 2`（`deepword:data:v2`，本版只做可缺省的新增字段，无破坏性变更）· 出题提示词 `PROMPT_VERSION = v1` · 新增讲解提示词 `FEEDBACK_PROMPT_VERSION = v1`

### 新增（Added）

- **学习页双 tab**：学习、闪卡。学习 tab 走「一轮」流程；闪卡 tab 用于已学词快速自查。
- **一轮学习流程**：新词 N 个（默认 1，可调 1～10；每词 4～8 题，默认 6）→ 复习 4～6 词（题量 `词数～2×词数`，默认 10）→ 小结 → 点「继续」进入下一轮；一轮进度持久化在本地，中途退出可恢复。
- **新词闪卡闸门**：先问「不认识 / 掌握」；点掌握翻面显示释义并追问确认，确认即标掌握，永久不再学习与复习；点不认识直接出题（无独立教学卡），第 1 题反馈附完整词条信息（音标、词性、释义、例句、标签）。本轮有多个新词时，每个新词各走一遍闸门。
- **闪卡 tab 快速自查**：已学词逐个自查，点「不认识」排进下一轮复习优先，点「掌握」翻面确认后可手动取消掌握。
- **掌握判定**：连续 3 次全对 + 覆盖 ≥2 技能 + 14 天无错 + 分布 ≥2 轮次，满足即自动标记掌握；掌握词退出学习与复习队列。
- **6 技能本地出题**：`en2zh`、`zh2en`、`spell`、`listen`、`sentence`、`translate` 全部本地生成、离线可用；听音题用浏览器 TTS（无可用英文语音则不出），互译题需配置 AI（未配置则不出），互译占比 ≤ 1/3。
- **薄弱分析**：从作答记录现算 6 个技能的正确率、最弱词与建议重点；仪表盘新增「薄弱分析」面板；复习选词与出题技能按薄弱度优先。
- **AI 反馈**：答错时流式讲解（错因 + 记忆点 + 改进），不自动跳题；答对给本地鼓励语并按设置自动跳下一题（3 秒 / 5 秒 / 手动）；互译每题判分三档 `perfect` / `good` / `poor`，`poor` 必须读完讲解才能继续；讲解与改进建议写入作答记录，成绩单可回看。
- **浏览器 TTS**：用浏览器内置语音朗读单词，支持能力检测、英文语音选择、语速 0.5～2 与发音自动播放；零依赖、零成本（云端 TTS 与 OS 级发音未做）。
- **本地降级**：AI 未配置、网络失败、超时或取消时自动降级为本地解析，判分与作答不中断。
- **练习设置**：设置页新增「练习设置」卡片——每轮新词数、每词题量、每轮复习词数、每轮复习题量、答对自动跳转、自动讲解开关、发音语速与英文语音选择；改动即时生效。

### 变更（Changed）

- 学习页由「四档自评闪卡 SRS」改为「闸门 + 多模块出题 + 薄弱度复习」；取消间隔重复排程，复习每轮必做、按薄弱度选词。
- 复习由「到期驱动」改为「每轮必做」：复习候选按薄弱度挑选（闪卡「不认识」标记优先），新词与已掌握词不进入复习列表。
- 仪表盘「到期复习」改为「待复习（按薄弱度）」；掌握度、错题待攻克、最近作答等既有指标口径保持不变。
- 作答记录新增 `skill` / `latencyMs` / `verdict` / `roundId` 与讲解字段；旧记录读取时保持缺省，不影响历史统计。
- 测试规模由 264 增至 384 用例：新增学习流程 124 例（出题、轮状态机、选词、掌握判定、薄弱分析、AI 反馈）。

### 修复（Fixed）

- 新词题量不再只覆盖部分题型：新词按技能表顺序尽量覆盖全部 6 种题型（无语音 / 无 AI 时回退到其余技能补齐题量）。
- 同一新词在一轮内不再重复出同一技能：每个技能准备多套题干变体并按 `wordId + skill + prompt` 去重。
- 掌握词不再参与复习排序与薄弱排名（`scoreReviewWord` / `scoreWordWeakness` 对已掌握词返回 0）。
- 流式反馈的 Key 脱敏：增量输出保留窗口，避免 API Key 跨 chunk 拼出后泄漏到界面。
- 支持火山方舟 Ark 等 Anthropic 兼容端点（新增 `volcengine` 厂商预设、Base URL 推断与思考参数映射）。
- 本地代理转发 Anthropic 兼容端点时的请求头与端点拼接修正。

### 移除（Removed）

- **旧版闪卡 SRS 学习页与学习队列**：三阶段学习页（扉页 → 四档自评 → 成绩单）与 `src/lib/session.ts` 的队列构建一并移除；SRS 排程算法仍保留在数据层，改由练习判分驱动（对 = `good`、错 = `again`），用于卡片进度与统计。

### 文档（Docs）

- 新增 `docs/phase-b-contract.md`（Phase B 并行开发的接口契约），并同步 `README.md`、`docs/spec.md`、`docs/architecture.md`、`docs/version-spec.md`、`docs/v2-design.md`、`docs/agents.md`。

---

## [1.0.1] - 2026-11-07

Phase A：多 provider 管理 + 本地代理 + 流式基建 + 数据 v1→v2 迁移。

**版本线**：应用 `1.0.1` · 数据格式 `DATA_VERSION = 2`（`deepword:data:v2`）· 提示词 `PROMPT_VERSION = v1`

### 新增（Added）

- **本地代理与同源转发**：新增零依赖 Node 代理 `server/proxy.mjs`（`POST /api/llm/forward`、`GET /api/health`）；dev 由 Vite middleware 提供，prod 由 `server/index.mjs` 单进程托管 `dist/` 与 `/api`（默认 `127.0.0.1:8787`）。浏览器不再直连厂商，所有 LLM 请求经同源代理转发；代理仅监听回环地址、剥离 `Origin/Referer/Cookie`、不跟随重定向、不缓存、不记录也不保存 Key。
- **多 provider 管理**：设置页「模型连接」可保存多份 OpenAI 兼容 / Anthropic 兼容配置（名称、协议、厂商、Base URL、API Key、模型白名单、默认模型、温度、最大输出、思考开关），上限 20 份；支持新增、编辑、删除与「设为当前使用」。
- **模型列表拉取与勾选**：经代理拉取服务商模型列表；弹窗支持搜索、全选/清空、重新拉取与手动添加 model id；首次全选、再次拉取保留旧勾选、新增默认不勾选、已下线模型标记保留。Ollama 的 `/models` 不可用时回落原生 `/api/tags`。
- **连通性测试**：以 `max_tokens: 1` + 强制关闭思考发一次极小请求，显示成功/失败、延迟与模型；空回复也算成功。
- **流式基建 `streamChat`**：支持 OpenAI `data:` delta 与 Anthropic `content_block_delta` 两种 SSE 协议，逐段 `onToken` 回调；兼容任意分块边界、CRLF 与上游降级为普通 JSON。
- **思考开关与 no-think 映射**：按厂商白名单注入关闭思考参数（Anthropic/DeepSeek/GLM/Kimi、通义千问/硅基流动、OpenAI、Ollama 各不相同，MiniMax/自定义不发）；上游 400 点名参数时去参重试一次。
- **火山方舟 Ark 预设**：厂商列表新增「火山方舟 / Ark」，一键填入 Anthropic 兼容的 `https://ark.cn-beijing.volces.com/api/coding` Base URL 与示例模型；该厂商的关闭思考参数复用 `thinking:{type:'disabled'}`。
- **数据 v2 结构与初始默认配置**：`AppData` 新增 `providers` / `activeProviderId` / `practice` / `session`；首次启动生成 1 份默认 provider 与默认练习设置。

### 变更（Changed）

- LLM 全链路改走同源 `/api/llm/forward`：浏览器不再直连厂商域名，也不再需要 CORS 配置。
- 设置页模型连接由「单份协议 + 模型表单」重构为「配置列表 + 编辑表单 + 模型列表弹窗 + 当前使用切换」；关于页展示当前配置、厂商与思考开关状态。
- 温度范围 0–1.5、最大输出 Tokens 64–32000；Base URL 仅接受 http(s) 并做主机名校验。
- 应用不再是纯静态站点：AI 功能需在本机起进程（`pnpm dev` 或 `pnpm build && pnpm start`）；纯静态托管时其余功能可用、AI 自动回退本地题库。
- 备份格式 `version = 2`，每份 provider 的 `apiKey` 导出时默认清空。
- 测试规模由 129 增至 264 用例：新增 LLM 144、本地代理 14、存储 34、Provider 配置层 12、模型行合并 6。

### 迁移（Migration）

- **v1 → v2 自动迁移**：读取到旧数据（`version === 1` 或「无 providers 但有旧 settings」）时，把单份 `settings` 转为名为「默认配置」的 provider（厂商按 Base URL 推断），补齐 `practice` / `session`，随后立即写回 v2。
- **旧键保留**：`deepword:data:v1` 迁移成功后保留一个 MINOR 版本周期不清除，便于降级排查；清空本地数据时同时删除 v1/v2 两键。
- **旧备份可导入**：1.0.0 导出的 v1 备份仍可导入并自动迁移；导入后覆盖词库、记录与配置，缺失的 Key 按协议 + Base URL 从本机现有配置继承。
- 迁移为纯函数（`migrateV1ToV2`），不改写入参。

### 修复（Fixed）

- **Anthropic 兼容 Base URL 端点拼接**：此前只填厂商前缀（火山方舟 `/api/coding`、DeepSeek `/anthropic` 等）会被拼成 `{前缀}/messages`，请求打到不存在的路径并返回 401；现改为补 `{前缀}/v1/messages`，填到版本层（`/v1`、`/v1beta`）时仍只补 `/messages`。
- **Anthropic 兼容网关鉴权头**：非官方主机额外发送 `Authorization: Bearer`（火山方舟 Ark 的模型列表只认 Bearer，消息接口两者皆可），官方 `api.anthropic.com` 仍只发 `x-api-key`，避免未知头。
- **Anthropic 模型列表地址**：厂商前缀同样补 `/v1/models`（此前拼成 `{前缀}/models` 导致拉取失败）。
- 移除 Anthropic 浏览器直连所需的 `anthropic-dangerous-direct-browser-access` 头：请求改由本地代理从服务端发出，不再需要浏览器直连豁免。
- 连通性测试不再要求模型返回非空内容，避免 1 token 下模型回空串被误判为连接失败。
- 代理把「无错误码的 fetch 失败」误判为 400 参数错误；现统一返回 502 `network` 并保留可读原因。
- 模型列表弹窗重新拉取时，未勾选的历史 model 也会被标「已下线」；现仅保留仍勾选的已下架项。
- 导入备份时单一配置会跨 Base URL 继承本机 API Key；现仅按「协议 + 归一化 Base URL」精确继承。

---

## [1.0.0] - 2026-11-07

首个版本：本地优先、以错题为师的 LLM 背单词工作台。

**版本线**：应用 `1.0.0` · 数据格式 `DATA_VERSION = 1`（`deepword:data:v1`）· 提示词 `PROMPT_VERSION = v1`

### 新增

- **闪卡与间隔重复（SRS）**：四档自评（没记住 / 有点模糊 / 记住了 / 太简单），SM-2 变体排程；`没记住` 进入 10 分钟学习步，难度系数限制在 1.3~3.0，单次间隔上限 180 天，间隔 ≥ 30 天视为「已掌握」；队列为「学习中 → 到期复习 → 新词」，默认每轮 24 张、新词上限 10 个；支持 `Space` 翻面、`1`–`4` 自评、`Esc` 结束本轮与浏览器语音朗读。
- **错题本**：闪卡答错与练习题答错都会累积错误次数、连续答对、最近错因（题型 + 题干），错词按「错误次数 / 最近出错」排序并参与权重排序（`getWeakWords`）。
- **AI 错题特训**：选词（默认按错误次数取前 8）→ 题量 4/6/8、难度「自适应 / 巩固基础 / 挑战」→ 大模型针对每个错词的错因生成 choice（词义/辨析）、fill（例句填空）、usage（用法判断）、correction（纠错判断）四类可自动判分练习 → 逐题即时判分与中文解析 → 成绩单复盘（正确率、答对/答错、用时、错题清单）→「再练一组」。
- **LLM 接入**：支持 OpenAI 兼容接口（OpenAI、DeepSeek、Moonshot、硅基流动、Ollama 等）与 Anthropic Messages API；baseUrl 自动拼接端点；连接测试；温度与最大输出 Tokens 可调；生成阶段进度文案与取消（AbortController）。
- **本地兜底出题**：未配置或调用失败时，用词库自身生成练习（错词优先、同词性/近义干扰、例句屈折形式挖空、等价答案容错），离线可用。
- **词库管理**：内置 190 个 CET-4 / CET-6 / 考研 / 雅思高频词（含音标、词性、例句与翻译）；搜索、按状态筛选（新词/学习中/复习中/已掌握/错词）、排序（最近添加/字母序/错误最多/最先到期）、添加、编辑、删除、分页；词库 JSON 导入（数组或含 `words` 的对象，自动去重）与导出。
- **今日仪表盘**：到期卡与新词、今日学习次数与目标（20 次）、近七日正确率、连续学习天数、28 天学习热力图、错题待攻克、掌握度分布、最近作答动态。
- **设置**：双协议切换与常用服务预设、API Key 显示/隐藏、连接测试（成功显示延迟与模型）、完整备份导出（默认不含 Key）/导入、清空学习进度、恢复初始示例词库、昼读/夜读主题。
- **数据安全**：localStorage 防抖持久化 + 页面隐藏/卸载前兜底落盘；读取时完整字段清洗、按 `id`/`term` 去重；损坏数据自动备份原始内容（`deepword:data:v1:corrupt:<ts>`）并降级为示例词库；配额满时给出可操作提示。
- **界面**：宣纸 × 墨色 × 朱砂的编辑感设计系统，宋体标题、衬线英文词、纸张颗粒纹理；响应式布局（桌面侧栏 / 移动端顶部导航）；暗色主题；`prefers-reduced-motion` 支持；弹窗焦点陷阱与焦点还原、表单 label 关联、跳转链接。
- **工程**：TypeScript 严格模式；129 个 Vitest 用例覆盖 SRS、统计、学习队列、存储与损坏恢复、本地出题、LLM 请求构造/解析/校验/错误映射；hash 路由；错误边界；README 与界面截图文档。

### 变更

- （首个版本，无历史变更）

### 修复

- 复习阶段第二次自评 `good` 未按难度系数扩展间隔的问题（首轮判断改为「仅首次作答使用固定学习步长」）。
- 导入备份后设置页草稿不同步、可能覆盖导入设置的问题。
- 跳转链接 `#main-content` 误触发 hash 路由导致切回仪表盘的问题。
- 弹窗关闭后焦点落回 `body`、`Tab` 可逃出弹窗的问题。

### 安全

- API Key 仅存本机 `localStorage`，输入框为密码类型；备份导出默认不含 Key；Key 不出现在 DOM、控制台、URL 或异常栈中。
- 模型输出一律视为不可信：严格 JSON 提取与逐题校验，非法/注入内容被丢弃；题干与解析按纯文本渲染，不执行 HTML。
- 浏览器直连 Anthropic 时携带 `anthropic-dangerous-direct-browser-access: true`；应用无后端，不上传任何学习数据。

### 移除

- 无（首个版本）。

### 文档

- 新增 `README.md`（功能、启动、模型配置、CORS 说明、项目结构、已知边界、界面预览）。
- 新增 `docs/architecture.md`（架构与数据流）、`docs/agents.md`（协作分工）、`docs/version-spec.md`（版本规格）、`docs/spec.md`（产品规格）。
- 新增 `CHANGELOG.md`（本文件）。
