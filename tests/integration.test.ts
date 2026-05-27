import { describe, expect, test } from "vitest";

// @vitest-environment jsdom

import { LoroDoc } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import { loroSyncPluginKey } from "../src/sync-plugin-key";
import { LoroUndoPlugin } from "../src/undo-plugin";
import {
  ROOT_DOC_KEY,
  type LoroDocType,
  type LoroNode,
  type LoroNodeMapping,
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

/**
 * Mount an EditorView in a jsdom environment so we can exercise the
 * full plugin lifecycle (init() in view() setup, view.dispatch during
 * construction, destroy unsubscribe). These tests guarantee the
 * synchronous-init fix actually works end-to-end — without them all
 * the apply-level tests in fixes.test.ts wouldn't catch a regression
 * in the EditorView construction path.
 */
function mountView(
  pmContent: unknown,
  loroDoc: LoroDocType,
  options: {
    onSyncEvent?: (e: import("../src/sync-plugin-key").LoroSyncEvent) => void;
  } = {},
): { view: EditorView; cleanup: () => void } {
  const place = document.createElement("div");
  document.body.appendChild(place);
  const state = EditorState.create({
    doc: pmContent
      ? schema.nodeFromJSON(pmContent)
      : schema.nodeFromJSON({ type: "doc", content: [] }),
    schema,
    plugins: [
      LoroSyncPlugin({ doc: loroDoc, onSyncEvent: options.onSyncEvent }),
    ],
  });
  const view = new EditorView(place, { state });
  return {
    view,
    cleanup: () => {
      view.destroy();
      place.remove();
    },
  };
}

describe("LoroSyncPlugin (integration: EditorView lifecycle)", () => {
  test("mounts on an empty Loro doc with empty PM doc — no crash, no clobber", () => {
    const doc: LoroDocType = new LoroDoc();
    const errors: import("../src/sync-plugin-key").LoroSyncEvent[] = [];
    const { view, cleanup } = mountView({ type: "doc", content: [] }, doc, {
      onSyncEvent: (e) => {
        if (e.kind === "error") errors.push(e);
      },
    });
    try {
      expect(view.state.doc.content.size).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("mounts on a Loro doc with content — replaces PM with Loro tree", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const { view, cleanup } = mountView({ type: "doc", content: [] }, doc);
    try {
      // After init, the PM doc should reflect Loro's content.
      expect(view.state.doc.textContent).toBe("Hello world");
    } finally {
      cleanup();
    }
  });

  test("mounts on an empty Loro doc with PM having content — seeds Loro from PM (no clobber)", () => {
    const doc: LoroDocType = new LoroDoc();
    const { view, cleanup } = mountView(helloWorld, doc);
    try {
      // PM content should NOT have been wiped.
      expect(view.state.doc.textContent).toBe("Hello world");
      // Loro should now contain the PM content.
      const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
      expect(root.get("nodeName")).toBe("doc");
      expect(getLoroMapChildren(root).length).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("destroy() unsubscribes from Loro after mount", () => {
    const doc: LoroDocType = new LoroDoc();
    const { view, cleanup } = mountView({ type: "doc", content: [] }, doc);
    cleanup();
    // After destroy, mutations to Loro should not throw or affect the
    // (now-destroyed) view.
    expect(() => {
      const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
      root.set("nodeName", "doc");
      doc.commit();
    }).not.toThrow();
    expect(view.isDestroyed).toBe(true);
  });

  test("emits onSyncEvent error and continues mounting when init fails", () => {
    // Pre-seed Loro with a node whose nodeName the schema doesn't accept.
    // createNodeFromLoroObj will fail; init() will throw inside view(),
    // get caught by the try/catch wrapper, and the editor still mounts.
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
    root.set("nodeName", "completelyUnknownNodeType");
    doc.commit();

    const errors: import("../src/sync-plugin-key").LoroSyncEvent[] = [];
    // Silence the expected console.error output.
    const realError = console.error;
    console.error = () => {};
    try {
      const { view, cleanup } = mountView({ type: "doc", content: [] }, doc, {
        onSyncEvent: (e) => {
          if (e.kind === "error") errors.push(e);
        },
      });
      try {
        // Editor should still be mounted (didn't throw out of constructor).
        expect(view.isDestroyed).toBe(false);
        // An error event with phase "init" should have been emitted.
        expect(errors.length).toBeGreaterThan(0);
        expect(
          errors.some((e) => e.kind === "error" && e.phase === "init"),
        ).toBe(true);
      } finally {
        cleanup();
      }
    } finally {
      console.error = realError;
    }
  });

  test("dispatches user input correctly after init (no init race)", async () => {
    // The original bug: setTimeout(() => init(view), 0) opened a window
    // where a synchronous user dispatch immediately after construction
    // would be wiped by init's replace(0, content.size). With the
    // synchronous init, this race is closed.
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const { view, cleanup } = mountView({ type: "doc", content: [] }, doc);
    try {
      // After construction returns, user dispatches. Init has ALREADY
      // run synchronously; the user input is preserved.
      const tr = view.state.tr.insertText("X", 1);
      view.dispatch(tr);
      expect(view.state.doc.textContent).toContain("X");
      expect(view.state.doc.textContent).toContain("Hello world");
    } finally {
      cleanup();
    }
  });
});

describe("LoroUndoPlugin (integration)", () => {
  test("double-mount of same UndoManager logs a warning", async () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const { UndoManager } = await import("loro-crdt");
    const undoManager = new UndoManager(doc, {});
    let warnCalls = 0;
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("LoroUndoPlugin")) {
        warnCalls++;
      }
    };

    const place1 = document.createElement("div");
    document.body.appendChild(place1);
    const state1 = EditorState.create({
      doc: schema.nodeFromJSON({ type: "doc", content: [] }),
      schema,
      plugins: [LoroSyncPlugin({ doc }), LoroUndoPlugin({ doc, undoManager })],
    });
    const view1 = new EditorView(place1, { state: state1 });

    const place2 = document.createElement("div");
    document.body.appendChild(place2);
    const state2 = EditorState.create({
      doc: schema.nodeFromJSON({ type: "doc", content: [] }),
      schema,
      plugins: [LoroSyncPlugin({ doc }), LoroUndoPlugin({ doc, undoManager })],
    });
    const view2 = new EditorView(place2, { state: state2 });

    try {
      expect(warnCalls).toBe(1);
    } finally {
      console.warn = realWarn;
      view1.destroy();
      view2.destroy();
      place1.remove();
      place2.remove();
    }
  });
});
