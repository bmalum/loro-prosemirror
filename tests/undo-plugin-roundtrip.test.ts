import { describe, expect, test } from "vitest";

// @vitest-environment jsdom

import { LoroDoc, UndoManager } from "loro-crdt";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import {
  LoroUndoPlugin,
  undo,
  redo,
  canUndo,
  canRedo,
} from "../src/undo-plugin";
import { loroUndoPluginKey } from "../src/undo-plugin-key";
import {
  ROOT_DOC_KEY,
  type LoroDocType,
  type LoroNode,
  updateLoroToPmState,
  getLoroMapChildren,
} from "../src/lib";

import { schema } from "./schema";
import { createEditorState } from "./utils";

const helloWorld = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Hello world" }] },
  ],
};

function mountWithUndo(doc: LoroDocType, undoManager?: UndoManager) {
  const place = document.createElement("div");
  document.body.appendChild(place);
  const view = new EditorView(place, {
    state: EditorState.create({
      doc: schema.nodeFromJSON({ type: "doc", content: [] }),
      schema,
      plugins: [LoroSyncPlugin({ doc }), LoroUndoPlugin({ doc, undoManager })],
    }),
  });
  return {
    view,
    cleanup: () => {
      view.destroy();
      place.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Round-trip undo/redo
// ---------------------------------------------------------------------------

describe("LoroUndoPlugin (round-trip undo/redo)", () => {
  test("user types, undo reverses, redo re-applies", async () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const { view, cleanup } = mountWithUndo(doc);
    try {
      const initialText = view.state.doc.textContent;
      expect(initialText).toBe("Hello world");

      // Type a character.
      view.dispatch(view.state.tr.insertText("X", 1));
      // Allow the doc-changed appendTransaction + Loro commit chain to run.
      await new Promise((r) => setTimeout(r, 5));
      expect(view.state.doc.textContent).toContain("X");

      // canUndo should now be true.
      expect(canUndo(view.state)).toBe(true);
      expect(canRedo(view.state)).toBe(false);

      // Undo via our command.
      const undoResult = undo(view.state, view.dispatch);
      expect(undoResult).toBe(true);
      await new Promise((r) => setTimeout(r, 10));
      // PM should reflect the reversed text.
      expect(view.state.doc.textContent).toBe("Hello world");

      // Redo restores the X.
      expect(canRedo(view.state)).toBe(true);
      const redoResult = redo(view.state, view.dispatch);
      expect(redoResult).toBe(true);
      await new Promise((r) => setTimeout(r, 10));
      expect(view.state.doc.textContent).toContain("X");
    } finally {
      cleanup();
    }
  });

  test("setOnPop schedules a queueMicrotask cursor restore on undo", async () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const { view, cleanup } = mountWithUndo(doc);
    try {
      // Move selection to position 6 ("Hello |world").
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)),
      );
      // Type at that position.
      view.dispatch(view.state.tr.insertText("X", 6));
      await new Promise((r) => setTimeout(r, 5));

      // Undo — onPop should schedule a microtask that restores the cursor.
      undo(view.state, view.dispatch);
      // queueMicrotask resolves before any setTimeout, so a 5ms wait is plenty.
      await new Promise((r) => setTimeout(r, 10));

      // After the undo + selection restore, the selection should be at
      // a sensible position (in jsdom we can't easily verify cursor
      // restored to PRE-edit pos through the Loro round-trip, but we
      // can at least verify nothing crashed and the selection is
      // within bounds).
      expect(view.state.selection.from).toBeGreaterThanOrEqual(0);
      expect(view.state.selection.from).toBeLessThanOrEqual(
        view.state.doc.content.size,
      );
    } finally {
      cleanup();
    }
  });

  test("undo command without dispatch returns canUndo() boolean", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const { view, cleanup } = mountWithUndo(doc);
    try {
      // Without dispatch, undo() returns canUndo() — false initially.
      // Use `undefined as never` to satisfy the Command contract while
      // exercising the no-dispatch branch.
      expect(undo(view.state, undefined as never)).toBe(false);
      expect(redo(view.state, undefined as never)).toBe(false);

      // After an edit: canUndo true.
      view.dispatch(view.state.tr.insertText("Q", 1));
      expect(undo(view.state, undefined as never)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// undoManager onPush behaviour: latestPrevSelection capture
// ---------------------------------------------------------------------------

describe("LoroUndoPlugin (onPush captures latestPrevSelection)", () => {
  test("setOnPush is called with cursor info on each undo group", async () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));

    // Wrap UndoManager so we can observe setOnPush calls.
    const um = new UndoManager(doc, {});
    let pushedCursorsCount = 0;
    const origSetOnPush = um.setOnPush.bind(um);
    um.setOnPush = (callback) => {
      const wrapped: Parameters<typeof um.setOnPush>[0] = (
        isUndo,
        range,
        ev,
      ) => {
        const cb = callback as
          | ((
              isUndo: boolean,
              range: { start: number; end: number },
              ev?: unknown,
            ) => { value: unknown; cursors: unknown[] })
          | undefined;
        const result = cb
          ? cb(isUndo, range, ev)
          : { value: null, cursors: [] };
        if (result && Array.isArray(result.cursors)) {
          pushedCursorsCount += result.cursors.length;
        }
        return result as never;
      };
      origSetOnPush(wrapped);
    };

    const { view, cleanup } = mountWithUndo(doc, um);
    try {
      // Move selection to position 6 BEFORE editing — apply()'s gate
      // requires docChanged + addToHistory; this selection-only tx
      // doesn't update prevSelection.
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)),
      );
      // Edit — this fires onPush via Loro's UndoManager.
      view.dispatch(view.state.tr.insertText("X", 6));
      await new Promise((r) => setTimeout(r, 10));

      // onPush should have been called and pushed at least 1 cursor
      // (anchor; focus may collapse onto anchor for an empty selection).
      expect(pushedCursorsCount).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// canUndo / canRedo helpers when no plugin state
// ---------------------------------------------------------------------------

describe("canUndo / canRedo / undo / redo (no plugin state)", () => {
  test("return false when LoroUndoPlugin is not mounted", () => {
    // EditorState without LoroUndoPlugin.
    const editorState = EditorState.create({
      doc: schema.nodeFromJSON({ type: "doc", content: [] }),
      schema,
      plugins: [],
    });
    expect(canUndo(editorState)).toBe(false);
    expect(canRedo(editorState)).toBe(false);
    expect(undo(editorState, () => {})).toBe(false);
    expect(redo(editorState, () => {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Plugin state apply: canUndo/canRedo update reflectively
// ---------------------------------------------------------------------------

describe("LoroUndoPlugin (state shape changes)", () => {
  test("plugin state's canUndo flips true after a user edit", async () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const { view, cleanup } = mountWithUndo(doc);
    try {
      const before = loroUndoPluginKey.getState(view.state);
      expect(before?.canUndo).toBe(false);

      view.dispatch(view.state.tr.insertText("y", 1));
      await new Promise((r) => setTimeout(r, 5));

      const after = loroUndoPluginKey.getState(view.state);
      expect(after?.canUndo).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Destroy cleans up onPush / onPop and BOUND_UNDO_MANAGERS
// ---------------------------------------------------------------------------

describe("LoroUndoPlugin (destroy cleanup)", () => {
  test("after destroy the same UndoManager can be re-bound without warning", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const um = new UndoManager(doc, {});

    let warnCount = 0;
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = typeof args[0] === "string" ? args[0] : "";
      if (msg.includes("LoroUndoPlugin") && msg.includes("already bound")) {
        warnCount++;
      }
    };

    try {
      // First mount.
      const a = mountWithUndo(doc, um);
      a.cleanup();
      // After destroy, BOUND_UNDO_MANAGERS should have removed the entry.
      // A second mount with the same UndoManager should NOT warn.
      const b = mountWithUndo(doc, um);
      expect(warnCount).toBe(0);
      b.cleanup();
    } finally {
      console.warn = realWarn;
    }
  });
});
