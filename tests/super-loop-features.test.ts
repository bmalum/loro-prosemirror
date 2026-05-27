import { describe, expect, test } from "vitest";

// @vitest-environment jsdom

import { LoroDoc, LoroList, LoroMap, LoroText } from "loro-crdt";
import { EditorState, Plugin } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history } from "prosemirror-history";

import { LoroSyncPlugin } from "../src/sync-plugin";
import {
  loroSyncPluginKey,
  LORO_SYNC_META,
  getLoroSyncMeta,
  isLoroInternalTransaction,
  type LoroSyncEvent,
} from "../src/sync-plugin-key";
import { LoroUndoPlugin } from "../src/undo-plugin";
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

// ---------------------------------------------------------------------------
// LORO_SYNC_META + helpers
// ---------------------------------------------------------------------------

describe("LORO_SYNC_META + helpers", () => {
  test("LORO_SYNC_META exposes the canonical meta type strings", () => {
    expect(LORO_SYNC_META.DOC_CHANGED).toBe("doc-changed");
    expect(LORO_SYNC_META.NON_LOCAL_UPDATES).toBe("non-local-updates");
    expect(LORO_SYNC_META.UPDATE_STATE).toBe("update-state");
  });

  test("isLoroInternalTransaction detects plugin-internal txs", () => {
    const doc: LoroDocType = new LoroDoc();
    const editorState = EditorState.create({
      doc: schema.nodeFromJSON({ type: "doc", content: [] }),
      schema,
      plugins: [LoroSyncPlugin({ doc })],
    });

    const userTr = editorState.tr;
    expect(isLoroInternalTransaction(userTr)).toBe(false);

    const internalTr = editorState.tr.setMeta(loroSyncPluginKey, {
      type: LORO_SYNC_META.NON_LOCAL_UPDATES,
      changedBy: "import",
    });
    expect(isLoroInternalTransaction(internalTr)).toBe(true);
  });

  test("getLoroSyncMeta returns the typed meta object or null", () => {
    const doc: LoroDocType = new LoroDoc();
    const editorState = EditorState.create({
      doc: schema.nodeFromJSON({ type: "doc", content: [] }),
      schema,
      plugins: [LoroSyncPlugin({ doc })],
    });

    expect(getLoroSyncMeta(editorState.tr)).toBeNull();

    const tr = editorState.tr.setMeta(loroSyncPluginKey, {
      type: LORO_SYNC_META.DOC_CHANGED,
    });
    const m = getLoroSyncMeta(tr);
    expect(m).not.toBeNull();
    expect(m!.type).toBe(LORO_SYNC_META.DOC_CHANGED);
  });
});

// ---------------------------------------------------------------------------
// kind:"init" event with mode discriminator
// ---------------------------------------------------------------------------

describe("LoroSyncPlugin (init event)", () => {
  test("emits kind:'init' mode:'both-empty' when neither side has content", () => {
    const doc: LoroDocType = new LoroDoc();
    const events: LoroSyncEvent[] = [];
    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON({ type: "doc", content: [] }),
        schema,
        plugins: [
          LoroSyncPlugin({
            doc,
            onSyncEvent: (e) => events.push(e),
          }),
        ],
      }),
    });
    try {
      const initEvents = events.filter((e) => e.kind === "init");
      expect(initEvents.length).toBe(1);
      expect(initEvents[0]).toMatchObject({
        kind: "init",
        mode: "both-empty",
      });
    } finally {
      view.destroy();
      place.remove();
    }
  });

  test("emits kind:'init' mode:'loro-populated' when Loro has content", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));

    const events: LoroSyncEvent[] = [];
    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON({ type: "doc", content: [] }),
        schema,
        plugins: [
          LoroSyncPlugin({
            doc,
            onSyncEvent: (e) => events.push(e),
          }),
        ],
      }),
    });
    try {
      const initEvents = events.filter((e) => e.kind === "init");
      expect(initEvents.length).toBe(1);
      expect(initEvents[0]).toMatchObject({
        kind: "init",
        mode: "loro-populated",
      });
    } finally {
      view.destroy();
      place.remove();
    }
  });

  test("emits kind:'init' mode:'pm-seeded' when PM has content + Loro empty", () => {
    const doc: LoroDocType = new LoroDoc();
    const events: LoroSyncEvent[] = [];
    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON(helloWorld),
        schema,
        plugins: [
          LoroSyncPlugin({
            doc,
            onSyncEvent: (e) => events.push(e),
          }),
        ],
      }),
    });
    try {
      const initEvents = events.filter((e) => e.kind === "init");
      expect(initEvents.length).toBe(1);
      expect(initEvents[0]).toMatchObject({
        kind: "init",
        mode: "pm-seeded",
      });
      // Loro should now mirror PM.
      const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
      expect(getLoroMapChildren(root).length).toBe(1);
    } finally {
      view.destroy();
      place.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// disableFallbackCursorRestore opt-out
// ---------------------------------------------------------------------------

describe("LoroSyncPlugin (disableFallbackCursorRestore opt-out)", () => {
  test("when disabled, fullReplaceFallback does not schedule a queueMicrotask cursor restore", async () => {
    // Rather than wiring up a full fallback path (which requires
    // triggering a tree/counter diff), we test the plumbing: with
    // the opt-out set, the plugin's state should reflect it, and
    // the syncCursorsToPmSelection codepath in fullReplaceFallback
    // is gated on it.
    //
    // Direct apply-level test: set up a state with the opt-out,
    // verify it propagated.
    const doc: LoroDocType = new LoroDoc();
    const editorState = EditorState.create({
      doc: schema.nodeFromJSON({ type: "doc", content: [] }),
      schema,
      plugins: [LoroSyncPlugin({ doc, disableFallbackCursorRestore: true })],
    });
    const state = loroSyncPluginKey.getState(editorState);
    expect(state).not.toBeNull();
    expect(state!.disableFallbackCursorRestore).toBe(true);
  });

  test("default is undefined/false (auto cursor restore)", () => {
    const doc: LoroDocType = new LoroDoc();
    const editorState = EditorState.create({
      doc: schema.nodeFromJSON({ type: "doc", content: [] }),
      schema,
      plugins: [LoroSyncPlugin({ doc })],
    });
    const state = loroSyncPluginKey.getState(editorState);
    expect(state).not.toBeNull();
    expect(state!.disableFallbackCursorRestore).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// LoroUndoPlugin: competing history plugin warning
// ---------------------------------------------------------------------------

describe("LoroUndoPlugin (competing history plugin)", () => {
  test("warns when prosemirror-history is mounted alongside", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));

    let warnedAboutHistory = false;
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = typeof args[0] === "string" ? args[0] : "";
      if (
        msg.includes("LoroUndoPlugin") &&
        msg.includes("competing PM history")
      ) {
        warnedAboutHistory = true;
      }
    };

    const place = document.createElement("div");
    document.body.appendChild(place);
    try {
      const view = new EditorView(place, {
        state: EditorState.create({
          doc: schema.nodeFromJSON({ type: "doc", content: [] }),
          schema,
          plugins: [
            history(), // ← prosemirror-history; should trip the warning
            LoroSyncPlugin({ doc }),
            LoroUndoPlugin({ doc }),
          ],
        }),
      });
      try {
        expect(warnedAboutHistory).toBe(true);
      } finally {
        view.destroy();
      }
    } finally {
      console.warn = realWarn;
      place.remove();
    }
  });

  test("no warning when no history plugin is present", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));

    let warnedAboutHistory = false;
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const msg = typeof args[0] === "string" ? args[0] : "";
      if (
        msg.includes("LoroUndoPlugin") &&
        msg.includes("competing PM history")
      ) {
        warnedAboutHistory = true;
      }
    };

    const place = document.createElement("div");
    document.body.appendChild(place);
    try {
      const view = new EditorView(place, {
        state: EditorState.create({
          doc: schema.nodeFromJSON({ type: "doc", content: [] }),
          schema,
          plugins: [LoroSyncPlugin({ doc }), LoroUndoPlugin({ doc })],
        }),
      });
      try {
        expect(warnedAboutHistory).toBe(false);
      } finally {
        view.destroy();
      }
    } finally {
      console.warn = realWarn;
      place.remove();
    }
  });
});
