import { describe, expect, test } from "vitest";

// @vitest-environment jsdom

import { Cursor, LoroDoc, LoroList, LoroText, type PeerID } from "loro-crdt";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import {
  convertPmSelectionToCursors,
  cursorToAbsolutePosition,
} from "../src/cursor/common";
import {
  CursorEphemeralStore,
  LoroEphemeralCursorPlugin,
} from "../src/cursor/ephemeral";
import { LoroSyncPlugin } from "../src/sync-plugin";
import { loroSyncPluginKey } from "../src/sync-plugin-key";
import {
  ROOT_DOC_KEY,
  type LoroDocType,
  type LoroNode,
  type LoroNodeContainerType,
  type LoroNodeMapping,
  createNodeFromLoroObj,
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

const twoParas = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "First" }] },
    { type: "paragraph", content: [{ type: "text", text: "Second" }] },
  ],
};

/**
 * Build a synced editor state where the PM Nodes ARE bound to Loro
 * containers via WEAK_NODE_TO_LORO_CONTAINER_MAPPING. This lets cursor
 * encoding actually find the loroId for a paragraph node.
 */
function buildSynced(content: unknown) {
  const doc: LoroDocType = new LoroDoc();
  updateLoroToPmState(doc, new Map(), createEditorState(schema, content));
  const innerDoc = doc.getMap(ROOT_DOC_KEY) as LoroNode;
  const mapping: LoroNodeMapping = new Map();
  const pmDoc = createNodeFromLoroObj(
    schema,
    innerDoc as unknown as LoroNode & { _branded: LoroNodeContainerType },
    mapping,
  );
  const editorState = EditorState.create({ doc: pmDoc, schema });
  return { doc, mapping, editorState, innerDoc };
}

// ---------------------------------------------------------------------------
// convertPmSelectionToCursors
// ---------------------------------------------------------------------------

describe("convertPmSelectionToCursors", () => {
  test("returns matching anchor + focus when selection is collapsed", () => {
    const { doc, mapping, editorState } = buildSynced(helloWorld);
    const sel = TextSelection.create(editorState.doc, 1);
    const { anchor, focus } = convertPmSelectionToCursors(
      editorState.doc,
      sel,
      { doc, mapping, changedBy: "local" } as never,
    );
    // For a collapsed selection both Cursors point to the same position;
    // they're the SAME cursor object (function shortcuts the second
    // call when selection.head === selection.anchor).
    expect(anchor).toBeDefined();
    expect(focus).toBe(anchor);
  });

  test("computes distinct anchor + focus when selection spans a range", () => {
    const { doc, mapping, editorState } = buildSynced(helloWorld);
    const sel = TextSelection.create(editorState.doc, 1, 6);
    const { anchor, focus } = convertPmSelectionToCursors(
      editorState.doc,
      sel,
      { doc, mapping, changedBy: "local" } as never,
    );
    expect(anchor).toBeDefined();
    expect(focus).toBeDefined();
    expect(focus).not.toBe(anchor);
  });

  test("returns undefined for both when the parent node isn't mapped", () => {
    const doc: LoroDocType = new LoroDoc();
    // Build a PM doc that has NO bindings in WEAK_NODE_TO_LORO_CONTAINER_MAPPING.
    const orphan = createEditorState(schema, helloWorld);
    const sel = TextSelection.create(orphan.doc, 1);
    const { anchor, focus } = convertPmSelectionToCursors(orphan.doc, sel, {
      doc,
      mapping: new Map(),
      changedBy: "local",
    } as never);
    expect(anchor).toBeUndefined();
    expect(focus).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cursorToAbsolutePosition (round-trip + edge cases)
// ---------------------------------------------------------------------------

describe("cursorToAbsolutePosition", () => {
  test("text-cursor round-trip: PM pos -> Cursor -> PM pos", () => {
    const { doc, mapping, editorState } = buildSynced(helloWorld);
    const sel = TextSelection.create(editorState.doc, 4);
    const { anchor } = convertPmSelectionToCursors(editorState.doc, sel, {
      doc,
      mapping,
      changedBy: "local",
    } as never);
    expect(anchor).toBeDefined();

    const [pos] = cursorToAbsolutePosition(anchor!, doc, mapping);
    expect(pos).not.toBeNull();
    // The round-trip should land at the same position.
    expect(pos).toBe(4);
  });

  test("text-cursor in second paragraph round-trips correctly", () => {
    const { doc, mapping, editorState } = buildSynced(twoParas);
    // Position inside the second paragraph (after "First"+open/close = 7).
    const targetPos = 9; // Inside "Second"
    const sel = TextSelection.create(editorState.doc, targetPos);
    const { anchor } = convertPmSelectionToCursors(editorState.doc, sel, {
      doc,
      mapping,
      changedBy: "local",
    } as never);
    expect(anchor).toBeDefined();

    const [pos] = cursorToAbsolutePosition(anchor!, doc, mapping);
    expect(pos).toBe(targetPos);
  });

  test("returns [null, undefined] for an unknown / invalid cursor", () => {
    const { doc, mapping } = buildSynced(helloWorld);
    // Construct a Cursor that points to a Loro container in a DIFFERENT
    // doc — when looked up in `doc`, getContainerById returns nothing.
    const otherDoc: LoroDocType = new LoroDoc();
    updateLoroToPmState(
      otherDoc,
      new Map(),
      createEditorState(schema, helloWorld),
    );
    const otherText = getLoroMapChildren(
      getLoroMapChildren(otherDoc.getMap(ROOT_DOC_KEY) as LoroNode).get(
        0,
      ) as LoroNode,
    ).get(0) as LoroText;
    const otherCursor = otherText.getCursor(0)!;

    const [pos] = cursorToAbsolutePosition(otherCursor, doc, mapping);
    expect(pos).toBeNull();
  });

  test("list-cursor (empty paragraph) maps to its containing block", () => {
    // Build a doc with an empty paragraph; cursor encoded at the
    // paragraph's children-list level (not inside a LoroText).
    const emptyParaDoc = {
      type: "doc",
      content: [{ type: "paragraph" }],
    };
    const { doc, mapping, editorState } = buildSynced(emptyParaDoc);

    const innerDoc = doc.getMap(ROOT_DOC_KEY) as LoroNode;
    const para = getLoroMapChildren(innerDoc).get(0) as LoroNode;
    const paraChildren = getLoroMapChildren(para);
    expect(paraChildren.length).toBe(0);

    // Get a list-style cursor on the (empty) children list.
    const listCursor = paraChildren.getCursor(0);
    expect(listCursor).toBeDefined();

    const [pos] = cursorToAbsolutePosition(listCursor!, doc, mapping);
    // Position should be inside the empty paragraph: 1 (right after open).
    expect(pos).not.toBeNull();
    expect(pos).toBeGreaterThanOrEqual(0);
    // Sanity: editorState's doc has only the one paragraph.
    expect(editorState.doc.childCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LoroEphemeralCursorPlugin: createDecorations path coverage
//
// We construct two stores (peerA local, peerB simulated remote), have
// peerA's editor receive peerB's awareness state, and check that a
// remote caret decoration is produced.
// ---------------------------------------------------------------------------

describe("LoroEphemeralCursorPlugin (createDecorations)", () => {
  test("renders a remote peer's cursor as a widget+inline decoration set", () => {
    const docA: LoroDocType = new LoroDoc();
    updateLoroToPmState(docA, new Map(), createEditorState(schema, helloWorld));

    // PeerB simulates a remote user. We need a real Cursor that
    // points into docA's text container so decoding succeeds in
    // peerA's render.
    const peerA = docA.peerIdStr;
    const peerB = "9999999999" as PeerID;
    const innerDoc = docA.getMap(ROOT_DOC_KEY) as LoroNode;
    const text = getLoroMapChildren(
      getLoroMapChildren(innerDoc).get(0) as LoroNode,
    ).get(0) as LoroText;
    const cursorAtZero = text.getCursor(0)!;
    const cursorAtFive = text.getCursor(5)!;

    const store = new CursorEphemeralStore(peerA);
    // Inject peerB's state into peerA's local store.
    store.set(peerB, {
      anchor: cursorAtZero.encode(),
      focus: cursorAtFive.encode(),
      user: { name: "Remote", color: "#f0a" },
    });

    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON({ type: "doc", content: [] }),
        schema,
        plugins: [
          LoroSyncPlugin({ doc: docA }),
          LoroEphemeralCursorPlugin(store, {}),
        ],
      }),
    });
    try {
      // Force a cursor-plugin re-render by dispatching with the magic meta
      // flag the plugin watches (presenceUpdated). We can find the plugin
      // key by introspection or by triggering a Loro event. Easiest:
      // set the local presence again (fires the "local" subscribe event)
      // and dispatch a no-op tx with non-local-updates meta to trip the
      // re-render branch.
      view.dispatch(
        view.state.tr.setMeta(loroSyncPluginKey, {
          type: "non-local-updates",
          changedBy: "import",
        }),
      );
      // The DecorationSet for the cursor plugin should now have entries
      // for the remote peer. We check via the plugin's contributed
      // decorations on the rendered DOM.
      const peerWidgets = place.querySelectorAll(".ProseMirror-loro-cursor");
      expect(peerWidgets.length).toBeGreaterThanOrEqual(1);
    } finally {
      view.destroy();
      place.remove();
    }
  });

  test("skips peers whose anchor or focus is missing", () => {
    const docA: LoroDocType = new LoroDoc();
    updateLoroToPmState(docA, new Map(), createEditorState(schema, helloWorld));
    const peerA = docA.peerIdStr;
    const peerB = "9999999999" as PeerID;

    const store = new CursorEphemeralStore(peerA);
    store.set(peerB, {
      anchor: null,
      focus: null,
      user: { name: "Remote", color: "#f0a" },
    });

    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON({ type: "doc", content: [] }),
        schema,
        plugins: [
          LoroSyncPlugin({ doc: docA }),
          LoroEphemeralCursorPlugin(store, {}),
        ],
      }),
    });
    try {
      view.dispatch(
        view.state.tr.setMeta(loroSyncPluginKey, {
          type: "non-local-updates",
          changedBy: "import",
        }),
      );
      const peerWidgets = place.querySelectorAll(".ProseMirror-loro-cursor");
      expect(peerWidgets.length).toBe(0);
    } finally {
      view.destroy();
      place.remove();
    }
  });
});
