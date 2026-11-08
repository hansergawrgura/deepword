# 开发流程

功能开发 → commit → PR → merge。发版版本线见 [versioning.md](./versioning.md)。代码形态见 [coding-standards.md](./coding-standards.md)。

## 功能开发

1. 从最新 `main` 拉分支。
   - Agent：`cursor/<short-kebab>`
   - 人工：`feat|fix|chore|docs|refactor/<short-kebab>`
2. 动手前阅读 [AGENTS.md](../AGENTS.md) 与 [coding-standards.md](./coding-standards.md)。
3. 按层改：`domain/` → `infra` / store → feature UI。副作用不进视图。
4. 用户文案：同一次改动同时更新 `en` 与 `zh-CN` catalogs。
5. 先跑相关 `pnpm exec vitest run test/<path>`；合入前跑下方完整 gate。
6. 用户可见变化写入同一 PR 的 `CHANGELOG.md` `[Unreleased]`（见 [documentation.md](./documentation.md)）。

## Commit

- Conventional Commits：`type(scope): summary`
  - summary 用英文祈使句（“add”、“fix”、“remove”）。
  - 正文可用中文。
- `type`：`feat` / `fix` / `refactor` / `test` / `docs` / `chore` / `perf`
- 一条 commit 一个意图；不混无关文件。
- 永不提交 `node_modules/`、密钥，或无关的手改 lockfile。依赖变更只用 **pnpm**，并连同 `pnpm-lock.yaml` 提交。
- 禁止：`--no-verify`、擅自 `--amend`、对 `main` force-push（除非维护者明确要求）。
- Agent：**仅在用户明确要求时**才 commit；message 用 HEREDOC 传入。

合入与提交前的 gate：

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Pull request 与 merge

1. 先 push 分支（首次加 `-u`），再用 `gh pr create` 开 PR（base：`main`）。
2. PR 正文：**Summary**（1–3 条）+ **Test plan** checklist。
3. 优先 **squash merge** 进 `main`，保持主线线性。发版提交遵循 [versioning.md](./versioning.md)。
4. 仅在本地/CI gate 绿、冲突已解决、无 WIP / 调试残留时合入。
5. 合入后删除远程功能分支（本地清理可选）。

## 发版

日常功能走本文。切应用版本用 [versioning.md](./versioning.md) 清单。此处不重复 SemVer 细则。
