# Agent Handoff: loro-prosemirror Incremental Sync Fork

## Context

You are working on a fork of `loro-prosemirror` (the ProseMirror binding for
the Loro CRDT library). The fork lives at:

```
~/Development/gitfarm/loro-prosemirror-fork/
```

The parent project (Super Loop) is at:
```
~/Development/gitfarm/super_loop/
```

## Your Mission

Replace the **full document replace** in `updateNodeOnLoroEvent`
(`src/sync-plugin.ts` line ~180) with **incremental ProseMirror Steps**
derived from Loro's event diffs.

Currently, every remote edit triggers:
```typescript
tr.replace(0, view.state.doc.content.size, new Slice(Fragment.from(node), 0, 0))
```

This rebuilds the entire PM document. Your job is to make it surgical:
```typescript
// Instead of full replace, compute minimal steps from the Loro event diff
const steps = loroEventToSteps(event, state.mapping, view.state.schema)
let tr = view.state.tr
for (const step of steps) tr.step(step)
tr.setMeta(loroSyncPluginKey, { type: "non-local-updates" })
view.dispatch(tr)
// No cursor restore needed — PM maps selection through steps automatically
```

## Read First

1. **`ROADMAP.md`** in this repo — full plan with phases, key files, event structure
2. **`src/sync-plugin.ts`** — the plugin, especially `updateNodeOnLoroEvent`
3. **`src/lib.ts`** — `createNodeFromLoroObj` (how the full rebuild works), `clearChangedNodes`
4. **`src/cursor/common.ts`** — Loro cursor ↔ PM position (you won't need this if steps work)
5. **`tests/`** — existing test suite

## Key Constraints

- **TypeScript** — the project uses TypeScript with strict mode
- **pnpm** — package manager (`pnpm install`, `pnpm test`, `pnpm build`)
- **vitest** — test runner
- **Must remain backward-compatible** — the existing API (`LoroSyncPlugin({ doc })`) must still work
- **Fallback** — if incremental mapping fails for an event, fall back to the full replace (safety net)
- **No new dependencies** — use only prosemirror-model, prosemirror-state, prosemirror-transform, loro-crdt

## The Hard Part

Translating Loro's event diffs to PM positions. The `mapping: Map<ContainerID, Node>` gives you
node references but not positions. You need to:

1. Walk the PM doc to find the position of a node (use `doc.descendants((node, pos) => ...)`)
2. For text diffs: offset within LoroText → offset within the PM text content at that position
3. For list diffs (children): index in LoroList → child index → compute position via `node.content`

Start with **Phase 2 (text operations)** — it's the most common case and gives the biggest win.
A paragraph where a remote user types a character should produce a single `ReplaceStep` inserting
that character at the right position, not a full doc rebuild.

## How to Test Against Super Loop

```bash
# Link the fork into Super Loop
cd ~/Development/gitfarm/super_loop/assets
# In package.json, change "loro-prosemirror" to "file:../../loro-prosemirror-fork"
npm install

# Rebuild assets
cd ~/Development/gitfarm/super_loop
mix assets.build

# Run the app
mix phx.server
# Open two browser tabs on the same doc, type in one, verify the other updates without cursor jump
```

## Success = No More Workarounds

When this fork works correctly, Super Loop's `doc.js` can remove:
- The `requestAnimationFrame` batching of remote imports
- The `window.setTimeout` monkey-patch
- The `CursorGuardExtension` (appendTransaction cursor clamp)
- The `remoteImportDepth` guard (still useful for echo suppression, but cursor is no longer affected)

The editor will just work — like Google Docs or Notion — with surgical updates that don't disturb
the local user's cursor, selection, scroll position, IME composition, or node view state.

## Build Commands

```bash
pnpm install          # install deps
pnpm test             # run vitest
pnpm build            # build dist/
pnpm test -- --watch  # watch mode for development
```
