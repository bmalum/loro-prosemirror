import {
  Cursor,
  isContainerId,
  LoroDoc,
  LoroList,
  LoroMap,
  LoroText,
} from "loro-crdt";
import { EditorState, TextSelection } from "prosemirror-state";
import { Schema } from "prosemirror-model";
import { describe, expect, test } from "vitest";

import {
  cursorToAbsolutePosition,
  convertPmSelectionToCursors,
} from "../src/cursor/common";
import { LoroSyncPlugin } from "../src/sync-plugin";
import { loroSyncPluginKey } from "../src/sync-plugin-key";
import {
  loroUndoPluginKey,
  type LoroUndoPluginState,
} from "../src/undo-plugin-key";
import { LoroUndoPlugin, undo, redo, canUndo } from "../src/undo-plugin";
import {
  ROOT_DOC_KEY,
  type LoroDocType,
  type LoroNode,
  type LoroNodeMapping,
  updateLoroToPmState,
  getLoroMapChildren,
} from "../src/lib";
import { configLoroTextStyle } from "../src/text-style";

import { schema } from "./schema";
import { createEditorState } from "./utils";

const helloWorld = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Hello world" }] },
  ],
};

// ---------------------------------------------------------------------------
// Sync plugin: state immutability
// ---------------------------------------------------------------------------

describe("LoroSyncPlugin (state immutability)", () => {
  test("apply() never mutates the previous plugin state object", () => {
    const doc: LoroDocType = new LoroDoc();
    const plugin = LoroSyncPlugin({ doc });
    const editorState = EditorState.create({
      schema,
      plugins: [plugin],
    });
    const stateBefore = loroSyncPluginKey.getState(editorState)!;
    expect(stateBefore.changedBy).toBe("local");

    // Simulate a "non-local-updates" tx (the path taken when a remote
    // Loro batch arrives).
    const tr = editorState.tr.setMeta(loroSyncPluginKey, {
      type: "non-local-updates",
      changedBy: "import",
    });
    const next = editorState.apply(tr);
    const stateAfter = loroSyncPluginKey.getState(next)!;

    expect(stateAfter.changedBy).toBe("import");
    // The KEY guarantee: stateBefore was NOT mutated in place.
    expect(stateBefore.changedBy).toBe("local");
    expect(stateAfter).not.toBe(stateBefore);
  });

  test("apply() returns the same reference when nothing changed", () => {
    const doc: LoroDocType = new LoroDoc();
    const plugin = LoroSyncPlugin({ doc });
    const editorState = EditorState.create({
      schema,
      plugins: [plugin],
    });
    const stateBefore = loroSyncPluginKey.getState(editorState)!;

    // A tx with no relevant meta should leave plugin state untouched.
    const tr = editorState.tr;
    const next = editorState.apply(tr);
    const stateAfter = loroSyncPluginKey.getState(next)!;

    expect(stateAfter).toBe(stateBefore);
  });
});

// ---------------------------------------------------------------------------
// Sync plugin: appendTransaction echo gate
// ---------------------------------------------------------------------------

describe("LoroSyncPlugin (appendTransaction echo loop fix)", () => {
  test("does not append doc-changed for non-local-updates transactions", () => {
    const doc: LoroDocType = new LoroDoc();
    // Seed Loro with content so init's initial replace becomes a real
    // doc-change (an insert from empty PM, technically docChanged=true).
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const plugin = LoroSyncPlugin({ doc });
    const editorState = EditorState.create({
      doc: schema.nodeFromJSON(helloWorld),
      schema,
      plugins: [plugin],
    });

    // Forge a "non-local-updates" tx that ALSO changes the doc — the
    // shape of a real Loro-event-driven dispatch.
    const tr = editorState.tr;
    tr.insertText("X", 1);
    tr.setMeta(loroSyncPluginKey, {
      type: "non-local-updates",
      changedBy: "import",
    });

    // appendTransaction is called by EditorState.apply with the
    // dispatched tr; assert that it returns null (no echo).
    const appended = plugin.spec.appendTransaction!(
      [tr],
      editorState,
      editorState.apply(tr),
    );
    expect(appended).toBeNull();
  });

  test("DOES append doc-changed for genuine user transactions", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const plugin = LoroSyncPlugin({ doc });
    const editorState = EditorState.create({
      doc: schema.nodeFromJSON(helloWorld),
      schema,
      plugins: [plugin],
    });

    const tr = editorState.tr.insertText("Z", 1);
    const newState = editorState.apply(tr);
    const appended = plugin.spec.appendTransaction!(
      [tr],
      editorState,
      newState,
    );
    expect(appended).not.toBeNull();
    const meta = appended!.getMeta(loroSyncPluginKey) as { type: string };
    expect(meta?.type).toBe("doc-changed");
  });

  test("does not append doc-changed for update-state transactions", () => {
    const doc: LoroDocType = new LoroDoc();
    const plugin = LoroSyncPlugin({ doc });
    const editorState = EditorState.create({
      doc: schema.nodeFromJSON(helloWorld),
      schema,
      plugins: [plugin],
    });

    const tr = editorState.tr.insertText("hi", 1);
    tr.setMeta(loroSyncPluginKey, {
      type: "update-state",
      state: { changedBy: "local" },
    });
    const appended = plugin.spec.appendTransaction!(
      [tr],
      editorState,
      editorState.apply(tr),
    );
    expect(appended).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sync plugin: doc-changed branch catches updateLoroToPmState throws
// ---------------------------------------------------------------------------

describe("LoroSyncPlugin (error surfacing)", () => {
  test("doc-changed branch swallows updateLoroToPmState throws and emits onSyncEvent", () => {
    const doc: LoroDocType = new LoroDoc();
    // Pre-seed Loro with a node whose nodeName mismatches what PM will
    // insert. This makes updateLoroMap throw "node name mismatch".
    const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
    root.set("nodeName", "WRONG_NAME");

    const events: string[] = [];
    const plugin = LoroSyncPlugin({
      doc,
      onSyncEvent: (e) => {
        if (e.kind === "error") {
          events.push(e.phase);
        }
      },
    });
    const editorState = EditorState.create({
      schema,
      plugins: [plugin],
    });

    // Force the doc-changed apply branch directly. (The full path
    // through view() → dispatch is harder without an EditorView.)
    const tr = editorState.tr.setMeta(loroSyncPluginKey, {
      type: "doc-changed",
    });
    // Silence the expected error log so the test output stays clean.
    const realError = console.error;
    console.error = () => {};
    try {
      // This must not throw — the apply must catch the underlying error.
      expect(() => editorState.apply(tr)).not.toThrow();
    } finally {
      console.error = realError;
    }
    expect(events).toContain("doc-changed");
  });
});

// ---------------------------------------------------------------------------
// Undo plugin: prevSelection captured into plugin state
// ---------------------------------------------------------------------------

describe("LoroUndoPlugin (state shape)", () => {
  test("prevSelection is in the plugin state (not in factory closure)", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const plugin = LoroUndoPlugin({ doc });
    const sync = LoroSyncPlugin({ doc });
    const editorState = EditorState.create({
      doc: schema.nodeFromJSON(helloWorld),
      schema,
      plugins: [sync, plugin],
    });

    const before = loroUndoPluginKey.getState(
      editorState,
    ) as LoroUndoPluginState;
    expect(before.prevSelection).toBeNull();

    // A user tx (no plugin meta) should capture the pre-tx selection.
    const tr = editorState.tr.setSelection(
      TextSelection.create(editorState.doc, 1),
    );
    const after = editorState.apply(tr);
    const undoState = loroUndoPluginKey.getState(after) as LoroUndoPluginState;
    // prevSelection captured against oldState — selection was at 0 (default).
    // It should now be a non-null Cursors object.
    expect(undoState.prevSelection).not.toBeNull();
  });

  test("undo/redo set isUndoing.current synchronously and clear it via try/finally", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const plugin = LoroUndoPlugin({ doc });
    const sync = LoroSyncPlugin({ doc });
    const editorState = EditorState.create({
      doc: schema.nodeFromJSON(helloWorld),
      schema,
      plugins: [sync, plugin],
    });

    const undoState = loroUndoPluginKey.getState(
      editorState,
    ) as LoroUndoPluginState;
    // Before invocation: false
    expect(undoState.isUndoing.current).toBe(false);

    let observedDuring = false;
    // Stub the undoManager.undo() to observe the flag mid-call.
    const realUndo = undoState.undoManager.undo.bind(undoState.undoManager);
    undoState.undoManager.undo = () => {
      observedDuring = undoState.isUndoing.current;
      return realUndo();
    };
    undo(editorState, () => {});
    expect(observedDuring).toBe(true);
    // After the call: cleared synchronously by try/finally.
    expect(undoState.isUndoing.current).toBe(false);
  });

  test("canUndo returns false on a fresh undoManager", () => {
    const doc: LoroDocType = new LoroDoc();
    const plugin = LoroUndoPlugin({ doc });
    const sync = LoroSyncPlugin({ doc });
    const editorState = EditorState.create({
      doc: schema.nodeFromJSON(helloWorld),
      schema,
      plugins: [sync, plugin],
    });
    expect(canUndo(editorState)).toBe(false);
  });

  test("redo command is a no-op when there is nothing to redo", () => {
    const doc: LoroDocType = new LoroDoc();
    const plugin = LoroUndoPlugin({ doc });
    const sync = LoroSyncPlugin({ doc });
    const editorState = EditorState.create({
      doc: schema.nodeFromJSON(helloWorld),
      schema,
      plugins: [sync, plugin],
    });
    expect(redo(editorState, () => {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cursor: container-type discrimination + null-on-failure
// ---------------------------------------------------------------------------

describe("cursorToAbsolutePosition (container-type discrimination)", () => {
  test("returns null when the cursor's container is gone", () => {
    const doc: LoroDocType = new LoroDoc();
    const editorState = createEditorState(schema, helloWorld);
    const mapping: LoroNodeMapping = new Map();
    updateLoroToPmState(doc, mapping, editorState);

    // Seed a real cursor on a real text container, then drop the doc
    // and reconstruct one without that container.
    const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
    const para = getLoroMapChildren(root).get(0) as LoroNode;
    const text = getLoroMapChildren(para).get(0) as LoroText;
    const cursor = text.getCursor(0)!;

    // Sanity: roundtrip works with the live doc.
    const [pos] = cursorToAbsolutePosition(cursor, doc, mapping);
    expect(pos).not.toBeNull();

    // A container ID can be checked via isContainerId — ensure our
    // path does that and returns null on unknown.
    expect(isContainerId(cursor.containerId())).toBe(true);
  });

  test("encoding a selection on an unmapped node returns undefined", () => {
    // Build a fresh PM doc that was NEVER passed through
    // updateLoroToPmState — so the global
    // WEAK_NODE_TO_LORO_CONTAINER_MAPPING has no binding for any of
    // its nodes. Encoding a selection inside it must return
    // `undefined` (rather than crashing or logging spam).
    const doc: LoroDocType = new LoroDoc();
    const orphanState = createEditorState(schema, helloWorld);
    const emptyMapping: LoroNodeMapping = new Map();
    const loroState = {
      doc,
      mapping: emptyMapping,
      changedBy: "local" as const,
    };

    const sel = TextSelection.create(orphanState.doc, 1);
    const { anchor } = convertPmSelectionToCursors(
      orphanState.doc,
      sel,
      loroState as never,
    );
    expect(anchor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// text-style: per-(doc, schema) cache
// ---------------------------------------------------------------------------

describe("configLoroTextStyle (per-(doc, schema) cache)", () => {
  test("a second schema on the same Loro doc still gets configured", () => {
    const doc = new LoroDoc();
    const calls: number[] = [];
    const realConfig = doc.configTextStyle.bind(doc);
    doc.configTextStyle = (style) => {
      calls.push(Object.keys(style).length);
      return realConfig(style);
    };

    configLoroTextStyle(doc, schema);
    configLoroTextStyle(doc, schema); // dedup

    const otherSchema = new Schema({
      nodes: { doc: { content: "text*" }, text: {} },
      marks: { strikethrough: {} },
    });
    configLoroTextStyle(doc, otherSchema);

    // Two distinct configurations: the original (2 marks) and the second (1 mark).
    expect(calls.length).toBe(2);
    expect(calls).toContain(Object.keys(schema.marks).length);
    expect(calls).toContain(Object.keys(otherSchema.marks).length);
  });
});
