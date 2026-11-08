# Coding standards

Applies to DeepDeep Word (`dpdp-word`). Keep changes small, typed, and layered.

## Package manager

Use **pnpm only**. See [AGENTS.md](../AGENTS.md).

## Directory layers

```
src/
├── domain/     # pure logic: types, questions, round FSM, mastery, weakness, stats
├── infra/      # storage, llm, tts (side effects)
├── app/        # shell, sidebar, store, version, identity
├── features/   # dashboard / study / wordbook / settings
├── ui/         # shared Modal, Toast, icons, ErrorBoundary
├── i18n/       # locale catalogs + t() + React provider
├── data/       # built-in wordbanks
└── styles/     # tokens / base / ui
```

- Business rules live in `domain/`.
- Side effects (AI, TTS, persistence orchestration) live in controllers / `infra` / store — not in views.
- Views render and call actions; they do not invent domain rules.

## Identity

Technical product IDs (storage keys, backup `app`/`scheme`, download prefixes, probe keys) come from **one module**: [`src/app/identity.ts`](../src/app/identity.ts).

- Do not hardcode `dpdp-word` / legacy `deepword` prefixes outside identity (except listing legacy keys inside identity itself).
- Display names belong in **i18n**, not identity.

## i18n

- All user-visible copy goes through `src/i18n` catalogs (`en`, `zh-CN`).
- Default locale is `en`.
- UI uses `useT()` / `useLocale()`. Domain and infra that emit user-facing text take a `t` function or return message keys + params — they must not hardcode locale strings.
- LLM **system** prompts (model-facing) are separate from UI i18n.

## Comments

- Prefer **no comment** when names and types already explain *what*.
- Keep short **why** comments for non-obvious product or algorithm rules.
- Do not write long file-header essays that duplicate `docs/`.
- Do not leave stale references to removed docs or phases.
- CSS may keep short section banners; brand comments use **DeepDeep Word**.

## Naming and style

- TypeScript strict; prefer explicit domain types from `domain/types`.
- Feature CSS co-located with the feature; shared tokens in `src/styles`.
- Tests next to modules (`*.test.ts`); cover domain and storage migrations.

## Out of scope for drive-by edits

No drive-by refactors, unrelated renames, or new markdown beyond the task. Follow this doc when the task *is* standards/docs work.
