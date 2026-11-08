# Documentation updates

## What lives where

| Doc | Audience | Update when |
| --- | --- | --- |
| [AGENTS.md](../AGENTS.md) | Agents + developers | Tooling, layer map, or hard constraints change |
| [docs/coding-standards.md](./coding-standards.md) | Anyone writing code | Conventions for layers, comments, i18n, identity |
| [docs/versioning.md](./versioning.md) | Releasers | Version lines or release steps change |
| [docs/documentation.md](./documentation.md) | Doc maintainers | This policy changes |
| [CHANGELOG.md](../CHANGELOG.md) | Users + releasers | Every user-visible change (keep `[Unreleased]` current) |
| i18n catalogs (`src/i18n/catalogs/`) | Product copy | Any user-facing string add/change |

Do not revive removed contract files or WorkBuddy skills. Prefer updating these docs over long in-file essays.

## Rules

1. **Same PR as the code** when behavior, identity keys, i18n keys, or layer rules change.
2. **CHANGELOG**: add bullets under `[Unreleased]` as you ship; categorize correctly (`文档` for docs-only).
3. **i18n**: add keys to **both** `en` and `zh-CN` in the same change; keep structures aligned so TypeScript catches drift.
4. **Stale refs**: delete comments/links that point at missing docs.
5. **Notes** under `notes/` are personal backlog, not project standards — do not treat them as contracts.
