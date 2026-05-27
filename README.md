# Prosemirror Binding for Loro

- Sync document state with Loro
- Sync cursors with Loro's EphemeralStore (preferred) or legacy Awareness and
  [Cursor](https://loro.dev/docs/tutorial/cursor)
- Undo/Redo in collaborative editing
- [🎨 Try it online](https://main--6661e86e215da40180d90507.chromatic.com)

```ts
import {
  CursorEphemeralStore,
  LoroEphemeralCursorPlugin,
  LoroSyncPlugin,
  LoroUndoPlugin,
  redo,
  undo,
} from "loro-prosemirror";
import { LoroDoc } from "loro-crdt";
import { EditorView } from "prosemirror-view";
import { EditorState } from "prosemirror-state";

const doc = new LoroDoc();
const presence = new CursorEphemeralStore(doc.peerIdStr);

const plugins = [
  ...pmPlugins,
  LoroSyncPlugin({ doc }),
  LoroUndoPlugin({ doc }),
  keymap({
    "Mod-z": undo,
    "Mod-y": redo,
    "Mod-Shift-z": redo,
  }),
  LoroEphemeralCursorPlugin(presence, {}),
];
const editor = new EditorView(editorDom, {
  state: EditorState.create({ doc, plugins }),
});
```

https://github.com/loro-dev/prosemirror/assets/18425020/d0f01760-b76c-43b5-b7f7-b0b224130d9d

## Syncing more than one editor instance

In case you want to sync multiple ProseMirror editor instances to the same Loro document, you can define for each ProseMirror editor the [Container ID](https://loro.dev/docs/advanced/cid) into which the editor's content will be stored:

```ts
const doc = new LoroDoc();
const map = doc.getMap("<unique-id-per-editor-instance>");

const plugins = [
  LoroSyncPlugin({ doc, containerId: map.id }),
  // see above for other plugins
];
```

## Incremental sync

`LoroSyncPlugin` translates each remote `LoroEventBatch` into a single
ProseMirror `Transaction` made of surgical steps:

| Loro diff                                           | ProseMirror step                                   |
| --------------------------------------------------- | -------------------------------------------------- |
| `LoroText` insert / delete                          | `ReplaceStep` over the affected range              |
| `LoroText` retain with attribute changes            | `AddMarkStep` / `RemoveMarkStep`                   |
| `LoroList` insert / delete on a children list       | `ReplaceStep` with the materialised block fragment |
| `LoroMap` updates on a block's `attributes` sub-map | `setNodeMarkup`                                    |

This means a remote keystroke costs O(edit_size), not O(doc_size), and
ProseMirror's built-in selection mapping keeps the local cursor, selection,
node views and decorations stable across remote updates — no manual
cursor-restore dance is required.

If a batch contains a diff this binding can't translate (currently `tree` and
`counter`, or events that reference an unknown mark in the schema), the
plugin transparently falls back to the legacy full-document rebuild, so the
ProseMirror doc never diverges from Loro.

The translator is also exposed for advanced consumers:

```ts
import { loroEventBatchToTransaction } from "loro-prosemirror";

const tr = loroEventBatchToTransaction(state, batch, mapping, doc);
if (tr != null) view.dispatch(tr);
```

### Observing sync events

Wire `LoroSyncPluginProps.onSyncEvent` to surface incremental-vs-fallback
metrics, fallback reasons, batch sizes etc. The hook fires once per
processed Loro event batch — plus a one-shot `init` event after the
plugin's bootstrap dispatch — and is safe to throw from (errors are
caught and logged):

```ts
LoroSyncPlugin({
  doc,
  onSyncEvent: (e) => {
    switch (e.kind) {
      case "init":
        // Tells you what the bootstrap dispatch did:
        //   "loro-populated" → Loro had content; PM was replaced.
        //   "pm-seeded"      → PM had content + Loro empty; PM was
        //                      written into Loro (LOCAL Loro commits
        //                      ARE emitted in this mode — wire-push
        //                      layers should expect them).
        //   "both-empty"     → mapping bound, no commits emitted.
        console.log("init mode:", e.mode);
        break;
      case "incremental":
        // Surgical Steps applied. e.eventCount, e.by, e.origin.
        break;
      case "fallback":
        console.warn("incremental bailed:", e.reason);
        break;
      case "error":
        // e.phase: "init" | "doc-changed" | "update-state" |
        //          "cursor-encode" | "cursor-decode" | "materialize"
        console.error("[loro-prosemirror]", e.phase, e.error);
        break;
    }
  },
});
```

### Init footprint (what the plugin does on mount)

When the plugin's `view()` runs, it executes a single bootstrap
dispatch. The dispatch sets the plugin's mapping, registers the Loro
subscription, and either:

| PM doc      | Loro doc    | Mode             | Local Loro commits during init  |
| ----------- | ----------- | ---------------- | ------------------------------- |
| empty       | empty       | `both-empty`     | None.                           |
| empty       | has content | `loro-populated` | None (no-op `sys:init` commit). |
| has content | empty       | `pm-seeded`      | One — PM written into Loro.     |
| has content | has content | `loro-populated` | None — PM is REPLACED by Loro.  |

Hosts that maintain a wire-push layer (e.g. a `subscribeLocalUpdates`
listener that pushes ops to a server) can use the `init` event to
distinguish expected init seeding from runtime regressions.

### Logging

By default the plugin only emits `error` and `warn` messages via
`console.*`. Pass a `logger` prop to opt into structured logging or
verbose tracing:

```ts
import {
  LoroSyncPlugin,
  createConsoleLogger,
  silentLogger,
} from "loro-prosemirror";

// Verbose: print every event-batch entry, skip filter, and PM->Loro
// write trace.
LoroSyncPlugin({ doc, logger: createConsoleLogger("debug") });

// Production-quiet: drop everything (your app already has its own
// telemetry pipeline).
LoroSyncPlugin({ doc, logger: silentLogger });

// Custom: forward to Sentry / Datadog / Pino / etc.
LoroSyncPlugin({
  doc,
  logger: {
    error: (msg, ctx) => Sentry.captureException(ctx?.error, { tags: { msg } }),
    warn: (msg, ctx) =>
      Sentry.captureMessage(msg, { extra: ctx, level: "warning" }),
    info: () => {},
    debug: () => {},
  },
});
```

The same `logger` prop is supported on `LoroUndoPlugin`. When omitted,
both plugins fall back to a built-in console logger filtered to `warn`.

### Custom `appendTransaction` plugins (no string hard-coding)

If your editor needs an `appendTransaction` plugin that reacts to
plugin-internal transactions — e.g. a "stamp missing block IDs"
extension that wants to skip stamping during a Loro-driven dispatch —
import the meta type constants instead of hard-coding strings:

```ts
import {
  LORO_SYNC_META,
  getLoroSyncMeta,
  isLoroInternalTransaction,
} from "loro-prosemirror";

new Plugin({
  appendTransaction(transactions) {
    // Skip our work entirely on plugin-internal txs.
    if (transactions.some(isLoroInternalTransaction)) return null;
    // …user-edit handling
  },
});

// Or pattern-match on the specific meta type:
const m = getLoroSyncMeta(tr);
if (m?.type === LORO_SYNC_META.NON_LOCAL_UPDATES) {
  // a remote (or undo) Loro batch was applied
}
```

### Cursor-restore opt-out for hosts with a custom restore mechanism

When the incremental translator can't apply a Loro batch (rare:
`tree` / `counter` diffs, schema-violating inserts, etc.), the plugin
falls back to a full document rebuild. After the rebuild the plugin
schedules a `queueMicrotask` cursor restore using Loro cursors
captured before the dispatch.

If your host editor restores the cursor itself — typically via an
`appendTransaction` plugin that detects `LORO_SYNC_META.NON_LOCAL_UPDATES`
and re-sets the selection synchronously inside the same tx batch — set
`disableFallbackCursorRestore: true` so the plugin's microtask doesn't
override your synchronous restore:

```ts
LoroSyncPlugin({ doc, disableFallbackCursorRestore: true });
```

### LoroUndoPlugin and competing history plugins

`LoroUndoPlugin` does NOT bind keys; it exposes `undo`/`redo` commands
that you wire into your keymap. Tiptap's `StarterKit` and many other
host editors include `prosemirror-history` by default. If both are
mounted and both are wired to the same key, the two undo stacks
desynchronize:

- `prosemirror-history` reverses local PM steps; the resulting tx
  flows through `LoroSyncPlugin`'s `appendTransaction` and is written
  to Loro as a NEW commit (not a Loro `UndoManager` pop).
- Loro's `UndoManager` records all PM-history-driven txs as separate
  commits. Calling `LoroUndoPlugin`'s `undo` then pops the wrong
  entry and PM is out of sync with the Loro op log.

`LoroUndoPlugin` logs a `console.warn` on mount when it detects a
competing `history$`-keyed plugin. The fix is host-side: either
disable the PM history plugin (`StarterKit.configure({ history: false })`)
or rely on PM history alone and don't call `undo`/`redo` from this
binding.
