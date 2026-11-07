---
name: deepword-release
description: Bumps the DeepWord application version in package.json, src/lib/version.ts and CHANGELOG.md, then validates the build and creates a Conventional Commits release commit. This skill should be used when the user asks to 升版本号 / 发布版本 / 打版本提交 / bump version / cut a release in the DeepWord repository. It does not touch DATA_VERSION, PROMPT_VERSION or STORAGE_KEY.
agent_created: true
---

# DeepWord 版本发布

## Overview

把一次 DeepWord 发布收敛成可重复的流程：同步三处应用版本号、把 `CHANGELOG.md` 的 `[Unreleased]` 转成正式条目、跑完项目要求的三项检查、创建一条符合 Conventional Commits 的提交。本 skill 是**项目级**（`.workbuddy/skills/`），供仓库内所有协作者共用。

## 适用范围与边界

- 只升**应用版本**这一条版本线（`package.json` / `APP_VERSION` / `CHANGELOG`）。
- **不要**改动 `DATA_VERSION`、`STORAGE_KEY`、迁移函数、`PROMPT_VERSION`、`FEEDBACK_PROMPT_VERSION`；数据/提示词版本有各自的升级条件，不属于本流程。
- **不要**改动历史版本号引用：`CHANGELOG.md` 里已发布版本的段落、`README.md` 里描述历史版本的句子，都是版本记录而非当前值。
- 不执行 `git push`、不创建 tag、不 amend、不跳过 hooks（`--no-verify`）。需要这些操作时由用户单独提出。

## 版本号决策

格式 `MAJOR.MINOR.PATCH`：

| 档位 | 场景 |
| --- | --- |
| MAJOR | 破坏性变更：数据格式需迁移且旧数据无法自动升级、LLM 协议变更使既有配置失效、路由/存储键改名；移除视图/字段也应走 MAJOR |
| MINOR | 向后兼容的新能力：新增视图/题型/统计维度、新增服务商预设、导出格式只增字段 |
| PATCH | 向后兼容的修复：文案、样式、边界 bug、性能优化、依赖补丁 |

目标版本不明确时，先读取 `CHANGELOG.md` 的 `[Unreleased]` 内容判断档位，再向用户确认版本号与提交范围；**git commit 不可逆，不要替用户猜**。

## 工作流

### 1. 确认输入

确认两件事：目标版本号（例如 `1.2.0`）与本次提交的范围（全部工作区改动 / 仅版本与发布文件）。用 `git status --short` 和 `git log --oneline -3` 汇报当前仓库状态，尤其是未提交改动的数量。

### 2. 更新版本号

从仓库根执行脚本，日期用本机当天（避免 UTC 跨日）：

```bash
date +%F
node .workbuddy/skills/deepword-release/scripts/bump_version.mjs <new-version> --date <YYYY-MM-DD> --dry-run
node .workbuddy/skills/deepword-release/scripts/bump_version.mjs <new-version> --date <YYYY-MM-DD>
```

脚本会同步以下三个位置，任一处未匹配到预期格式即**报错退出而不写任何文件**：

| 文件 | 改动 |
| --- | --- |
| `package.json` | `version` |
| `src/lib/version.ts` | `APP_VERSION` |
| `CHANGELOG.md` | `## [Unreleased]` 的内容转为 `## [<version>] - <date>`，并留下空的 `## [Unreleased]\n\n暂无。` |

脚本拒绝版本号不升反降、`[Unreleased]` 无内容、SemVer 格式错误。加 `--force` 才允许降级。

用 `git diff -- package.json src/lib/version.ts CHANGELOG.md` 复核结果，确认没有误改历史版本引用。

### 3. 提交前检查

`AGENTS.md` 要求提交前至少跑过这三项，**只用 pnpm**（禁止 npm / npx / yarn / bun）：

```bash
pnpm typecheck
pnpm test
pnpm build
```

任一项失败就停止，不要创建提交。

### 4. 创建提交

按第 1 步确认的范围暂存文件，提交信息遵循 Conventional Commits，正文用中文描述用户可见变化：

```bash
git add -A                       # 或用户指定的路径
git commit -m "chore(release): v<new-version>" -m "- <本次用户可见变化 1>
- <本次用户可见变化 2>"
```

发布提交通常用 `chore(release):`；若本次同时包含功能性改动，按主导类型选 `feat:` / `fix:` / `refactor:`，并在正文写明版本升级。

### 5. 复核

```bash
git show --stat --oneline HEAD
git status --short
```

向用户报告：版本号前后值、改动文件清单、三项检查结果、提交哈希与提交信息、以及工作区是否干净。

## 资源

- `scripts/bump_version.mjs`：确定性版本号更新脚本。支持 `--dry-run`、`--force`、`--date`、`--help`。自动向上定位含 `name: deepword` 的 `package.json` 作为仓库根，因此从任意目录调用均可。脚本**不执行任何 git 操作**。
