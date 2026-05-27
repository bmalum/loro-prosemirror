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
