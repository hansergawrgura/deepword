# 版本与发版

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 与 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。CHANGELOG 分类：`新增` / `变更` / `迁移` / `修复` / `移除` / `安全` / `文档`。

## 版本线

| 线 | 位置 | 何时 bump |
| --- | --- | --- |
| **应用** `APP_VERSION` | [`package.json`](../package.json) 的 `version` **与** [`src/app/version.ts`](../src/app/version.ts)（必须一致） | 用户可见功能、修复或打包变化 |
| **数据** `DATA_VERSION` | [`src/app/identity.ts`](../src/app/identity.ts) / 领域类型 | 破坏旧载荷的 schema 形态变化 |
| **讲解提示词** `FEEDBACK_PROMPT_VERSION` | `src/infra/llm/feedbackPrompts.ts` | 面向用户的讲解提示词契约变化 |

存储键由 identity 推导为 `` `${APP_ID}:data:v${DATA_VERSION}` ``。改 `APP_ID` 或 `DATA_VERSION` 会换键；需规划迁移或绿场清空。

清洗器能安全给默认值的可选增量字段（如 `locale`）**不要** bump `DATA_VERSION`。

## 应用 SemVer

- **MAJOR**：对用户破坏数据/API 预期（如清空、备份不兼容）。
- **MINOR**：向后兼容的新能力。
- **PATCH**：修复，以及无行为风险的小文档/chore。

每次正式发版在 [CHANGELOG.md](../CHANGELOG.md) 写 `[X.Y.Z]` 段；进行中的改动放在 `[Unreleased]`。

## 发版清单

1. 决定 SemVer 档位；注明是否改动 `DATA_VERSION` / 提示词版本。
2. 把 `[Unreleased]` 迁入带日期的 `[X.Y.Z]`；留下空的新 `[Unreleased]`。
3. `package.json` 与 `src/app/version.ts` 写成同一版本号。
4. 跑 `pnpm typecheck`、`pnpm test`、`pnpm build`。
5. 用 Conventional Commits 提交，例如 `chore(release): vX.Y.Z`（正文可用中文）。
6. 除非维护者要求，否则不 push、不打 tag、不 amend、不跳过 hooks。

仓库内无自动升版本 skill；按本清单手动执行。
