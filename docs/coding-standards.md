# 编码规范

适用于 DeepDeep Word（`dpdp-word`）。改动宜小、类型明确、分层清晰。

## 包管理器

**只用 pnpm**。详见 [AGENTS.md](../AGENTS.md)。

## 目录分层

```
src/
├── domain/     # 纯逻辑：types、出题、一轮 FSM、掌握、薄弱、统计
├── infra/      # storage、llm、tts（副作用）
├── app/        # shell、sidebar、store、version、identity
├── features/   # dashboard / study / wordbook / settings
├── ui/         # 共用 Modal、Toast、icons、ErrorBoundary
├── i18n/       # 文案 catalogs + t() + React provider
├── data/       # 内置词库
└── styles/     # tokens / base / ui

test/           # Vitest，镜像 src/（代理测例在 test/server）
```

- 业务规则放在 `domain/`。
- 副作用（AI、TTS、持久化编排）放在 controller / `infra` / store，不要进视图。
- 视图只负责渲染与调用 actions，不发明领域规则。
- 测试放在 **`test/`**，不与生产模块并列。

## Identity

技术向产品 ID（存储键、备份 `app`/`scheme`、下载前缀、探测键）只来自 **一个模块**：[`src/app/identity.ts`](../src/app/identity.ts)。

- 不要在 identity 之外硬编码 `dpdp-word` / 旧版 `deepword` 前缀（identity 内列举遗留键除外）。
- 展示名属于 **i18n**，不属于 identity。

## i18n

- 所有用户可见文案走 `src/i18n` catalogs（`en`、`zh-CN`）。
- 默认语言为 `zh-CN`。
- UI 用 `useT()` / `useLocale()`。domain / infra 若产出用户文案，应接收 `t` 或返回 message key + 参数，禁止写死语言字符串。
- 面向模型的 LLM **system** 提示词与 UI i18n 分离。

## 注释

完整规则见 [comments.md](./comments.md)。摘要：禁止「复述代码在干什么」；只留短 why；禁止文件头长文与过期 Phase 考古。

## 命名与风格

- TypeScript strict；领域类型优先用 `domain/types`。
- Feature CSS 与功能同目录；共用 token 在 `src/styles`。
- 测试在 `test/`，路径镜像 `src/`（例：`src/domain/practice.ts` → `test/domain/practice.test.ts`）；覆盖 domain 与 storage 迁移/清洗。

## 开发循环

- 分支、commit、PR、merge 见 [dev-workflow.md](./dev-workflow.md)。
- 优先小 PR、单一意图；代码改动时同步更新 `[Unreleased]` 与两套 i18n catalogs。
- 合入前跑 `pnpm typecheck`、`pnpm test`、`pnpm build`。
- 不要在视图里发明领域规则或直接打 infra——经 store / controller actions 派发。

## 顺手改动的边界

禁止顺手大重构、无关重命名，或任务无关的新 markdown。若任务本身就是规范/文档工作，则按本文与 docs 约定改。
