# AGENTS.md

DeepDeep Word (`dpdp-word`). All agents and developers follow these conventions.

Longer norms live under [`docs/`](docs/README.md): [coding standards](docs/coding-standards.md), [comments](docs/comments.md), [dev workflow](docs/dev-workflow.md) (branch / commit / PR / merge), [versioning](docs/versioning.md), [documentation](docs/documentation.md).

## Package manager: pnpm only

- Allowed: `pnpm install`, `pnpm add`, `pnpm add -D`, `pnpm remove`, `pnpm <script>`, `pnpm exec`
- Forbidden: `npm` / `npx` / `yarn` / `bun`, and lockfiles other than `pnpm-lock.yaml`
- Do not hand-edit or delete `pnpm-lock.yaml`; commit it with dependency changes
- Do not commit `node_modules/`

### Common commands

| Action | Command |
| --- | --- |
| Install | `pnpm install` |
| Dev server | `pnpm dev` (Vite + local proxy, `http://127.0.0.1:5173`) |
| Typecheck | `pnpm typecheck` |
| Unit tests | `pnpm test`; single file `pnpm exec vitest run test/<path>` |
| Production build | `pnpm build` |
| Production run | `pnpm build && pnpm start` (default `127.0.0.1:8787`) |
| Static preview | `pnpm preview` (no `/api` proxy; AI unavailable) |

Before commit: at least `pnpm typecheck`, `pnpm test`, `pnpm build`.

## Directory layout (v3)

```
src/
├── domain/          # pure domain
├── infra/           # storage / llm / tts
├── app/             # shell, store, version, identity
├── features/        # dashboard / study / wordbook / settings
├── ui/
├── i18n/            # locales + t()
├── data/wordbanks/
└── styles/

test/                # Vitest; mirrors src/ (+ test/server)
```

- Domain rules in `domain/`; side effects in controller / `infra` / store.
- Technical IDs from `src/app/identity.ts` only (storage key derived from `APP_ID` + `DATA_VERSION`).
- No v1/v2 data migration beyond clearing legacy `deepword:*` keys after one-shot v3 migrate.
- User-facing strings go through `src/i18n` (default locale `zh-CN`).
- Tests live in `test/`, not colocated under `src/`. Comment rules: [docs/comments.md](docs/comments.md).
