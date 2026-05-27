# loro-prosemirror Fork — Incremental Sync

## Status

Phases 1-4 are complete and merged on `feat/incremental-sync`. The
binding now translates remote `LoroEventBatch`es into surgical
ProseMirror transactions; the legacy full-document rebuild is retained
only as a safety net for diff kinds the translator doesn't yet handle
(`tree`, `counter`, unknown mark names). 26 tests cover text, list, map,
nested structures, multi-event imports, missing-mapping safety, and a
deterministic 40-edit fuzz roundtrip across two peers.

Phase 5 (integration into Super Loop) lives in the consumer repo and is
not part of this fork.

## Goal

Replace the full-document-replace approach in `updateNodeOnLoroEvent` with
**incremental ProseMirror Steps** derived from Loro's event diffs. This
eliminates the O(doc_size) rebuild on every remote edit and makes cursor
preservation automatic (PM's native selection mapping handles it).

## Current Architecture (what we're replacing)

```
Remote edit arrives → doc.import(bytes)
  → Loro fires LoroEventBatch (event.by === "import")
  → updateNodeOnLoroEvent:
      1. clearChangedNodes (invalidates mapping cache)
      2. createNodeFromLoroObj (rebuilds ENTIRE PM node tree from Loro)
      3. tr.replace(0, doc.content.size, newDoc) — FULL REPLACE
      4. setTimeout → syncCursorsToPmSelection (restore cursor via Loro cursors)
```

**Problems:**

- O(doc_size) per remote keystroke
- Destroys all PM positions → cursor jumps
- Destroys all decorations → flicker
- Destroys node views → re-mount React components
- Breaks IME composition
- 190 rebuilds/sec at 20 users

## Target Architecture

```
Remote edit arrives → doc.import(bytes)
  → Loro fires LoroEventBatch with structured diffs
  → incrementalSync:
      1. For each event in batch:
         - Map Loro container path → PM position
         - Translate diff → ReplaceStep / AddMarkStep / RemoveMarkStep
      2. Build a single PM transaction with all steps
      3. view.dispatch(tr) — surgical, cursor stays put automatically
```

**Benefits:**

- O(edit_size) per remote edit
- Cursor preservation is free (PM maps selection through steps)
- Decorations survive
- Node views survive
- IME composition unaffected
- Works at 1000+ users

## Roadmap

### Phase 1: Foundation ✅

- [x] Set up the fork with proper build + test infrastructure
- [x] Understand the Loro event structure (`LoroEventBatch.events[].diff`)
- [x] Map Loro container IDs to PM positions (`findContainerLocation`)
- [x] Stub `loroEventBatchToTransaction` returning `null` so the legacy
      rebuild is the safety net for everything until later phases
- [x] Test harness in `tests/incremental.test.ts`

### Phase 2: Text operations ✅

- [x] `LoroText` insert → `ReplaceStep` at the right offset
- [x] `LoroText` delete → `ReplaceStep` removing the range
- [x] `LoroText` retain with mark attributes → `AddMarkStep` / `RemoveMarkStep`
- [x] Cursor preservation via ProseMirror's selection mapping
- [x] Concurrent text edit (peer A imports peer B's keystrokes)

### Phase 3: Block operations ✅

- [x] `LoroList` insert → `ReplaceStep` with materialised block fragment
- [x] `LoroList` delete → `ReplaceStep` removing the affected range
- [x] `LoroList` move (delete + insert) handled implicitly
- [x] `LoroMap` attribute updates → `setNodeMarkup`
- [x] Skip cascading events on freshly-materialised subtrees so we don't
      duplicate content

### Phase 4: Edge cases ✅

- [x] Nested structures (bulletList inside listItem inside bulletList)
- [x] Multi-event import (text edit + new block in the same batch)
- [x] Missing-mapping safety (events on un-materialised containers bail
      cleanly to the fallback)
- [x] Deterministic 40-edit fuzz roundtrip across two peers
- [x] Hot-path assertion: text inserts never fall back

### Phase 5: Integration (out of scope for this fork)

- Consumer-repo work: drop the binding into the host application,
  remove the workarounds (`requestAnimationFrame` batching,
  `setTimeout` monkey-patch, `CursorGuardExtension`, etc.), benchmark
  rebuilds/sec under multi-user load.

## Key Files

| File                   | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `src/sync-plugin.ts`   | The plugin — `updateNodeOnLoroEvent` is the target function         |
| `src/lib.ts`           | `createNodeFromLoroObj`, `updateLoroToPmState`, `clearChangedNodes` |
| `src/cursor/common.ts` | Loro cursor ↔ PM position conversion                               |
| `tests/`               | Existing test suite (vitest)                                        |

## Key Loro Event Structure

```typescript
interface LoroEventBatch {
  by: "local" | "import" | "checkout";
  origin?: string;
  events: LoroEvent[];
}

interface LoroEvent {
  target: ContainerID; // which container changed
  path: (string | number)[]; // path from root to target
  diff: Diff; // what changed
}

// For LoroText:
interface TextDiff {
  type: "text";
  diff: {
    insert?: string;
    delete?: number;
    retain?: number;
    attributes?: Record<string, any>;
  }[];
}

// For LoroList (children):
interface ListDiff {
  type: "list";
  diff: { insert?: Container[]; delete?: number; retain?: number }[];
}

// For LoroMap (attributes):
interface MapDiff {
  type: "map";
  updated: Record<string, { value: any; old?: any }>;
}
```

## The Critical Mapping Problem

The hardest part: translating a Loro container path to a PM document position.

The existing `mapping: Map<ContainerID, Node>` maps Loro container IDs to PM
Node references. But we need **positions**, not nodes. The approach:

1. After each full sync, build a reverse index: `Map<ContainerID, { node, pos }>`
2. On incremental update, look up the target container's position
3. For text diffs: the offset within the LoroText maps directly to the offset
   within the PM text node (they're 1:1 for plain text; marks complicate this)
4. For list diffs: the index in the LoroList maps to the child index of the
   parent PM node → compute position from `node.content.child(index)`

## Build & Test

```bash
cd ~/Development/gitfarm/loro-prosemirror-fork
pnpm install
pnpm test        # existing tests
pnpm build       # produces dist/
```

To use in Super Loop during development:

```bash
# In super_loop/assets/package.json, replace:
#   "loro-prosemirror": "^0.4.3"
# with:
#   "loro-prosemirror": "file:../../loro-prosemirror-fork"
cd ~/Development/gitfarm/super_loop/assets && npm install
```

## Success Criteria

1. All existing tests pass
2. New test: 10 concurrent editors making random edits for 60s — no cursor jumps, no crashes
3. `updateNodeOnLoroEvent` no longer calls `tr.replace(0, doc.content.size, ...)`
4. CPU usage per client drops 3-5× under multi-user load
5. Super Loop's `doc.js` can remove: rAF batching, setTimeout intercept, CursorGuardExtension
