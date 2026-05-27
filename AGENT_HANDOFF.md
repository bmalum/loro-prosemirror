# Agent Handoff: loro-prosemirror Incremental Sync Fork

## Status

**Done.** Phases 1–4 of the [ROADMAP](./ROADMAP.md) are complete on the
`feat/incremental-sync` branch. The binding now translates each
`LoroEventBatch` into a single ProseMirror `Transaction` of surgical
steps; the legacy full-document rebuild is retained only as a safety net
for diff kinds the translator doesn't yet handle (`tree`, `counter`,
events that reference an unknown mark in the schema).

This document is kept as a historical record of the original handoff;
see the README's "Incremental sync" section for the public-facing
description and `src/incremental-sync.ts` for the implementation.

## Where the work landed

| Concern                                | File                        |
| -------------------------------------- | --------------------------- |
| Public API — translator + position     | `src/incremental-sync.ts`   |
| Plugin wiring (try-incremental → full) | `src/sync-plugin.ts`        |
| Public re-exports                      | `src/index.ts`              |
| Tests (26)                             | `tests/incremental.test.ts` |
| Release notes                          | `CHANGELOG.md` (Unreleased) |

## How to run the suite

```bash
pnpm install
pnpm test          # vitest, ~26 tests in tests/incremental.test.ts
pnpm lint          # tsc --noEmit
pnpm check-format  # prettier --check
pnpm build         # tsdown -> dist/
```

## What the consumer (Super Loop) can now drop

When this fork is depended on as `loro-prosemirror`, the host app can
remove the cursor-restore workarounds that existed only to compensate
for the previous full-document rebuild:

- `requestAnimationFrame` batching of remote imports
- `window.setTimeout` monkey-patch
- `CursorGuardExtension` (appendTransaction cursor clamp)
- `remoteImportDepth` guard (still useful for echo suppression, but the
  cursor is no longer affected)

The editor will just work — surgical updates that don't disturb the
local user's cursor, selection, scroll position, IME composition, or
node view state.
