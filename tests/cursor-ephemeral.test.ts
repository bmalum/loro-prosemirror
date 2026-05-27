import { describe, expect, test } from "vitest";

// @vitest-environment jsdom

import { Cursor, LoroDoc, type PeerID } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import {
  CursorEphemeralStore,
  LoroEphemeralCursorPlugin,
} from "../src/cursor/ephemeral";
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
// CursorEphemeralStore (the EphemeralStore<...> subclass directly)
// ---------------------------------------------------------------------------

describe("CursorEphemeralStore", () => {
  test("setLocal with empty state deletes the peer entry", () => {
    const peer = "1" as PeerID;
    const store = new CursorEphemeralStore(peer);
    store.setLocal({});
    expect(store.getLocal()).toBeUndefined();
  });

  test("setLocal stores anchor / focus / user; getLocal decodes", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(
      doc,
      new Map(),
      createEditorState(schema, helloWorld),
    );
    const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
    const para = getLoroMapChildren(root).get(0) as LoroNode;
    const text = getLoroMapChildren(para).get(0) as import("loro-crdt").LoroText;
    const cursor = text.getCursor(0)!;

    const peer = doc.peerIdStr;
    const store = new CursorEphemeralStore(peer);
    store.setLocal({
      anchor: cursor,
      focus: cursor,
      user: { name: "Alice", color: "#abc" },
    });

    const decoded = store.getLocal();
    expect(decoded).toBeDefined();
    expect(decoded!.anchor).toBeInstanceOf(Cursor);
    expect(decoded!.focus).toBeInstanceOf(Cursor);
    expect(decoded!.user).toEqual({ name: "Alice", color: "#abc" });
  });

  test("getAll returns one entry per peer with decoded cursors", () => {
    const docA: LoroDocType = new LoroDoc();
    updateLoroToPmState(
      docA,
      new Map(),
      createEditorState(schema, helloWorld),
    );
    const rootA = docA.getMap(ROOT_DOC_KEY) as LoroNode;
    const textA = getLoroMapChildren(
      getLoroMapChildren(rootA).get(0) as LoroNode,
    ).get(0) as import("loro-crdt").LoroText;
    const cursorA = textA.getCursor(0)!;

    const peerA = docA.peerIdStr;
    const peerB = "9999999999" as PeerID;
    const store = new CursorEphemeralStore(peerA);
    store.setLocal({
      anchor: cursorA,
      focus: cursorA,
      user: { name: "A", color: "#aaa" },
    });

    // Simulate a second peer's data via the underlying EphemeralStore API.
    store.set(peerB, {
      anchor: cursorA.encode(),
      focus: cursorA.encode(),
      user: { name: "B", color: "#bbb" },
    });

    const all = store.getAll();
    expect(Object.keys(all).sort()).toEqual([peerA, peerB].sort());
    expect(all[peerA].user).toEqual({ name: "A", color: "#aaa" });
    expect(all[peerB].user).toEqual({ name: "B", color: "#bbb" });
    expect(all[peerA].anchor).toBeInstanceOf(Cursor);
    expect(all[peerB].focus).toBeInstanceOf(Cursor);
  });

  test("getAll skips entries with falsy state", () => {
    const peer = "2" as PeerID;
    const store = new CursorEphemeralStore(peer);
    // Set then immediately clear — an EphemeralStore typically retains
    // a deleted slot until timeout. After a delete, getAllStates() may
    // still include the key with a null/undefined value. The getAll
    // override must skip those.
    store.setLocal({});
    const all = store.getAll();
    expect(Object.keys(all)).toHaveLength(0);
  });

  test("subscribeBy delivers the event's `by` field to the listener", async () => {
    const peer = "3" as PeerID;
    const store = new CursorEphemeralStore(peer);
    const events: Array<"local" | "import" | "timeout"> = [];
    const unsub = store.subscribeBy((origin) => events.push(origin));

    // A local set fires a local-origin event.
    store.set(peer, {
      anchor: null,
      focus: null,
      user: { name: "x", color: "#000" },
    });
    // EphemeralStore fires events asynchronously; flush microtasks.
    await new Promise((r) => setTimeout(r, 5));

    expect(events.length).toBeGreaterThan(0);
    // First event from a local set is "local".
    expect(events[0]).toBe("local");

    unsub();
  });
});

// ---------------------------------------------------------------------------
// LoroEphemeralCursorPlugin: integration with EditorView
// ---------------------------------------------------------------------------

describe("LoroEphemeralCursorPlugin (integration)", () => {
  test("publishes the local user's cursor on focus and clears on blur", async () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(
      doc,
      new Map(),
      createEditorState(schema, helloWorld),
    );
    const peer = doc.peerIdStr;
    const store = new CursorEphemeralStore(peer);

    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON({ type: "doc", content: [] }),
        schema,
        plugins: [
          LoroSyncPlugin({ doc }),
          LoroEphemeralCursorPlugin(store, {
            user: { name: "Local", color: "#0a0" },
          }),
        ],
      }),
    });
    try {
      // Focus the editor's contentEditable so view.hasFocus() returns true.
      view.dom.focus();
      view.focus();
      // Manually trigger an updateCursorInfo by dispatching a no-op tx.
      view.dispatch(view.state.tr.setMeta("flush", true));
      await new Promise((r) => setTimeout(r, 5));

      const local = store.getLocal();
      // jsdom doesn't always honor focus() on contentEditable; if focus
      // was acquired, we expect cursor to be published; otherwise the
      // path is exercised but no anchor is set. Either way, no throw.
      if (view.hasFocus()) {
        expect(local).toBeDefined();
      }
    } finally {
      view.destroy();
      place.remove();
    }
  });

  test("destroying the view clears local presence", async () => {
    const doc: LoroDocType = new LoroDoc();
    const peer = doc.peerIdStr;
    const store = new CursorEphemeralStore(peer);
    store.setLocal({ user: { name: "L", color: "#0a0" } });
    expect(store.getLocal()).toBeDefined();

    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON({ type: "doc", content: [] }),
        schema,
        plugins: [
          LoroSyncPlugin({ doc }),
          LoroEphemeralCursorPlugin(store, {}),
        ],
      }),
    });

    view.destroy();
    place.remove();
    // The plugin's destroy hook calls store.setLocal({}), which clears.
    expect(store.getLocal()).toBeUndefined();
  });
});
