# 文档更新约定

## 文档放哪里

| 文档 | 读者 | 何时更新 |
| --- | --- | --- |
| [AGENTS.md](../AGENTS.md) | Agent + 开发者 | 工具链、分层图或硬约束变化 |
| [docs/coding-standards.md](./coding-standards.md) | 写代码的人 | 分层、i18n、identity、测试布局约定变化 |
| [docs/comments.md](./comments.md) | 写代码的人 | 注释卫生规则变化 |
| [docs/dev-workflow.md](./dev-workflow.md) | Agent + 开发者 | 分支 / commit / 推 main 流程变化 |
| [docs/versioning.md](./versioning.md) | 发版人 | 版本线或发版步骤变化 |
| [docs/documentation.md](./documentation.md) | 文档维护者 | 本政策本身变化 |
| [CHANGELOG.md](../CHANGELOG.md) | 用户 + 发版人 | 每个用户可见变化（保持 `[Unreleased]` 最新） |
| i18n catalogs（`src/i18n/catalogs/`） | 产品文案 | 任一用户可见字符串增改 |

不要复活已删除的契约文件或 WorkBuddy skill。优先改这些 docs，而不是在源码里写长文。

`docs/` 正文使用**中文**；代码标识符、路径、命令保持原文。

## 规则

1. 行为、identity 键、i18n 键或分层规则变化时，**与代码同一提交** 更新文档。
2. **CHANGELOG**：随开发往 `[Unreleased]` 追加条目；分类写对（纯文档用 `文档`）。
3. **i18n**：同一次改动同时改 `en` 与 `zh-CN`；结构对齐，方便 TypeScript 抓漂移。
4. **过期引用**：删掉指向已不存在文档的注释/链接。
5. **`notes/`** 是个人 backlog，不是项目规范，勿当契约。
