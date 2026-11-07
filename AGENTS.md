# AGENTS.md

在本仓库工作的所有 Agent 与开发者都遵守以下约定。

## 包管理器：统一使用 pnpm

**本项目只使用 pnpm。** 依赖锁文件是 `pnpm-lock.yaml`（唯一），`pnpm-workspace.yaml` 配置构建脚本白名单。

- ✅ 允许：`pnpm install`、`pnpm add <pkg>`、`pnpm add -D <pkg>`、`pnpm remove <pkg>`、`pnpm <script>`、`pnpm exec <bin>`
- ❌ 禁止：`npm install` / `npm run` / `npx`、`yarn`、`bun`，以及生成 `package-lock.json`、`yarn.lock`、`bun.lockb`
- ❌ 不要手改或删除 `pnpm-lock.yaml`；依赖变更后锁文件必须随代码一起提交
- ❌ 不要提交 `node_modules/`

### 常用命令

| 操作 | 命令 |
| --- | --- |
| 安装依赖 | `pnpm install` |
| 开发服务器 | `pnpm dev`（Vite 内置本地代理，默认 `http://127.0.0.1:5173`） |
| 类型检查 | `pnpm typecheck` |
| 单元测试 | `pnpm test`；单文件用 `pnpm exec vitest run <路径>` |
| 生产构建 | `pnpm build` |
| 生产运行 | `pnpm build && pnpm start`（默认 `127.0.0.1:8787`） |
| 静态预览 | `pnpm preview`（不含 `/api` 代理，AI 功能不可用） |

提交前至少跑过 `pnpm typecheck`、`pnpm test`、`pnpm build`。

## 布局约定

- **所有视图的「中间内容」统一用 `.view-stage` + `.view-stage__inner`**（定义在 `src/styles/ui.css` 的「统一舞台布局」区块）：舞台占满主内容区剩余高度，阶段容器**填充**这块空间，容器内部再按 `--stage-justify`（默认 `safe center`）把内容垂直居中；内容超高时自动退回顶部对齐。没有卡片边框的阶段用 `.view-stage__pane`。
- 垂直对齐、上下留白、最大宽度只在该区块通过 `--stage-*` 变量与 `.view-stage--sheet` / `.view-stage--practice` 两个档位修改，**不要**在各视图组件里另写 `max-width: ...; margin: 0 auto` 或另起一套居中/填充类名。
- 学习页所有阶段（计划 / 闸门 / 答题 / 小结 / 概览）都挂在同一个 `.view-stage__inner` 下；想改整体对齐只需改 `ui.css` 这一处。学习页是单页流程，没有 tab（闪卡自查 tab 与错题特训页已移除）。
- **学习页使用 `.view-stage--fixed`**：四边留白统一为 `--stage-inset`，外框宽高只由可用空间决定、与内容无关；各阶段容器用 `--study-pane-pad` 保持四边一致内边距。不要再给学习页加 `.view-stage--sheet` / `.view-stage--practice` 档位切换，也不要加宽度过渡。
- 顶部工具条 / 进度条放在 `.view-stage` 之外，作为固定区；进度条在 `.study` 顶部有常驻占位槽，出现 / 消失都不改变舞台纵坐标。

## 其他约定

- 样式只使用 `src/styles/tokens.css` 里的设计变量；暗色主题由 `document.documentElement` 上的 `[data-theme='dark']` 驱动，不要写死颜色。
- 协作分工与写入范围见 [docs/agents.md](docs/agents.md)；产品需求与内部契约见 [docs/](docs/)。注意：`docs/` 中关于「闪卡 tab」「错题特训 / `#/drill`」的章节是历史设计记录，当前实现已移除这两个界面，不要再据此新增入口或视图。
