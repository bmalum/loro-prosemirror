# loro-prosemirror Fork — Incremental Sync

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

### Phase 1: Foundation (Week 1)
- [ ] Set up the fork with proper build + test infrastructure
- [ ] Understand the Loro event structure (`LoroEventBatch.events[].diff`)
- [ ] Map Loro container IDs to PM positions using the existing `mapping: Map<ContainerID, Node>`
- [ ] Write a `loroEventToSteps(event, mapping, schema)` function skeleton
- [ ] Add test harness: create a LoroDoc, make edits, capture events, verify steps

### Phase 2: Text Operations (Week 2)
- [ ] Handle `LoroText` insert (→ `ReplaceStep` at the right offset)
- [ ] Handle `LoroText` delete (→ `ReplaceStep` removing range)
- [ ] Handle `LoroText` mark changes (→ `AddMarkStep` / `RemoveMarkStep`)
- [ ] Handle concurrent text edits in the same paragraph
- [ ] Test: two users typing in the same paragraph simultaneously

### Phase 3: Block Operations (Week 2-3)
- [ ] Handle `LoroList` insert (new block added → `ReplaceStep` inserting node)
- [ ] Handle `LoroList` delete (block removed → `ReplaceStep` removing node)
- [ ] Handle `LoroList` move (block reordered → delete + insert steps)
- [ ] Handle `LoroMap` attribute changes (→ `SetNodeMarkup` step)
- [ ] Test: drag-and-drop reorder, heading level change, etc.

### Phase 4: Edge Cases (Week 3)
- [ ] Handle nested structures (lists within lists, tables)
- [ ] Handle concurrent block + text edits
- [ ] Handle the "container doesn't exist in mapping yet" case (new blocks from remote)
- [ ] Fallback: if incremental mapping fails, fall back to full replace (safety net)
- [ ] Test: stress test with 10 concurrent editors making random edits

### Phase 5: Integration (Week 4)
- [ ] Wire into Super Loop's `doc.js` as a drop-in replacement
- [ ] Verify cursor preservation without any guard plugins
- [ ] Verify presence overlay works without position clamping hacks
- [ ] Performance benchmark: measure rebuilds/sec, DOM mutations, CPU usage
- [ ] Remove all workarounds from `doc.js` (rAF batching, setTimeout intercept, CursorGuardExtension)

## Key Files

| File | Purpose |
|------|---------|
| `src/sync-plugin.ts` | The plugin — `updateNodeOnLoroEvent` is the target function |
| `src/lib.ts` | `createNodeFromLoroObj`, `updateLoroToPmState`, `clearChangedNodes` |
| `src/cursor/common.ts` | Loro cursor ↔ PM position conversion |
| `tests/` | Existing test suite (vitest) |

## Key Loro Event Structure

```typescript
interface LoroEventBatch {
  by: "local" | "import" | "checkout";
  origin?: string;
  events: LoroEvent[];
}

interface LoroEvent {
  target: ContainerID;      // which container changed
  path: (string | number)[]; // path from root to target
  diff: Diff;               // what changed
}

// For LoroText:
interface TextDiff {
  type: "text";
  diff: { insert?: string; delete?: number; retain?: number; attributes?: Record<string, any> }[];
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
