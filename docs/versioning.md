# Versioning and releases

This project follows [Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/). Categories in Chinese: `新增` / `变更` / `迁移` / `修复` / `移除` / `安全` / `文档`.

## Version lines

| Line | Where | When to bump |
| --- | --- | --- |
| **App** `APP_VERSION` | [`package.json`](../package.json) `version` **and** [`src/app/version.ts`](../src/app/version.ts) (must match) | User-visible feature, fix, or packaging change |
| **Data** `DATA_VERSION` | [`src/app/identity.ts`](../src/app/identity.ts) / domain types | Schema shape change that breaks old payloads |
| **Feedback prompt** `FEEDBACK_PROMPT_VERSION` | `src/infra/llm/feedbackPrompts.ts` | User-facing explanation prompt contract change |

Storage key is derived as `` `${APP_ID}:data:v${DATA_VERSION}` `` from identity. Changing `APP_ID` or `DATA_VERSION` changes the key; plan migration or greenfield wipe accordingly.

Do **not** bump `DATA_VERSION` for optional additive fields that cleaners default safely (e.g. `locale`).

## SemVer for the app

- **MAJOR**: breaking data/API expectations for users (e.g. wipe / incompatible backup).
- **MINOR**: backward-compatible features.
- **PATCH**: fixes and small docs/chore with no behavior risk.

Record every release under `[X.Y.Z]` in [CHANGELOG.md](../CHANGELOG.md). Keep `[Unreleased]` for WIP.

## Release checklist

1. Decide SemVer bump; note whether `DATA_VERSION` / prompt versions change.
2. Move `[Unreleased]` notes into a dated `[X.Y.Z]` section; leave a fresh empty `[Unreleased]`.
3. Set the same version in `package.json` and `src/app/version.ts`.
4. Run `pnpm typecheck`, `pnpm test`, `pnpm build`.
5. Commit with Conventional Commits, e.g. `chore(release): vX.Y.Z` (Chinese body OK).
6. Do not push, tag, amend, or skip hooks unless the maintainer asks.

There is no automated bump skill in-repo; follow this checklist manually.
