import { describe, expect, test } from "vitest";

// @vitest-environment jsdom

import { Cursor, LoroDoc, type PeerID } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import {
  CursorAwareness,
  LoroCursorPlugin,
  cursorEq,
} from "../src/cursor/awareness";
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

function makeCursorOnText(): {
  doc: LoroDocType;
  cursor: Cursor;
  peer: PeerID;
} {
  const doc: LoroDocType = new LoroDoc();
  updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
  const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
  const text = getLoroMapChildren(
    getLoroMapChildren(root).get(0) as LoroNode,
  ).get(0) as import("loro-crdt").LoroText;
  return { doc, cursor: text.getCursor(0)!, peer: doc.peerIdStr };
}

// ---------------------------------------------------------------------------
// CursorAwareness
// ---------------------------------------------------------------------------

describe("CursorAwareness", () => {
  test("setLocal stores cursors as bytes; getLocal decodes them back", () => {
    const { cursor, peer } = makeCursorOnText();
    const aware = new CursorAwareness(peer);
    aware.setLocal({
      anchor: cursor,
      focus: cursor,
      user: { name: "Alice", color: "#abc" },
    });

    const local = aware.getLocal();
    expect(local).toBeDefined();
    expect(local!.anchor).toBeInstanceOf(Cursor);
    expect(local!.focus).toBeInstanceOf(Cursor);
    expect(local!.user).toEqual({ name: "Alice", color: "#abc" });
  });

  test("setLocal with no anchor/focus/user stores nulls; getLocal returns undefined-ish fields", () => {
    const peer = "1" as PeerID;
    const aware = new CursorAwareness(peer);
    aware.setLocal({});

    const local = aware.getLocal();
    expect(local).toBeDefined();
    // anchor / focus serialize to null then decode to undefined.
    expect(local!.anchor).toBeFalsy();
    expect(local!.focus).toBeFalsy();
    expect(local!.user).toBeNull();
  });

  test("getLocal returns undefined when no local state has been set", () => {
    const peer = "2" as PeerID;
    const aware = new CursorAwareness(peer);
    expect(aware.getLocal()).toBeUndefined();
  });

  test("getAll iterates all peers and decodes their cursors", () => {
    const { cursor, peer: peerA } = makeCursorOnText();
    const aware = new CursorAwareness(peerA);
    aware.setLocal({
      anchor: cursor,
      focus: cursor,
      user: { name: "A", color: "#aaa" },
    });

    // Inject a second peer's awareness state via the protocol's
    // applyLocalUpdate path is internal; the simplest workable shape is
    // applying an encoded update from a second CursorAwareness instance.
    // PeerID is parsed as a u64 decimal string by Loro.
    const peerB = "9999999999" as PeerID;
    const awareB = new CursorAwareness(peerB);
    awareB.setLocal({
      anchor: cursor,
      focus: cursor,
      user: { name: "B", color: "#bbb" },
    });
    const updateBytes = awareB.encode([peerB]);
    aware.apply(updateBytes);

    const all = aware.getAll();
    expect(Object.keys(all).sort()).toEqual([peerA, peerB].sort());
    expect(all[peerA].anchor).toBeInstanceOf(Cursor);
    expect(all[peerB].anchor).toBeInstanceOf(Cursor);
  });
});

// ---------------------------------------------------------------------------
// cursorEq
// ---------------------------------------------------------------------------

describe("cursorEq (awareness module)", () => {
  test("two null/undefined cursors compare equal", () => {
    expect(cursorEq(null, null)).toBe(true);
    expect(cursorEq(undefined, undefined)).toBe(true);
    expect(cursorEq(null, undefined)).toBe(true);
  });

  test("a cursor compared with null/undefined is unequal", () => {
    const { cursor } = makeCursorOnText();
    expect(cursorEq(cursor, null)).toBe(false);
    expect(cursorEq(null, cursor)).toBe(false);
  });

  test("the same cursor compares equal to itself", () => {
    const { cursor } = makeCursorOnText();
    expect(cursorEq(cursor, cursor)).toBe(true);
  });

  test("cursors at different positions on the same text compare unequal", () => {
    const { doc } = makeCursorOnText();
    const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
    const text = getLoroMapChildren(
      getLoroMapChildren(root).get(0) as LoroNode,
    ).get(0) as import("loro-crdt").LoroText;
    const a = text.getCursor(0)!;
    const b = text.getCursor(1)!;
    expect(cursorEq(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LoroCursorPlugin: integration with EditorView
// ---------------------------------------------------------------------------

describe("LoroCursorPlugin (integration)", () => {
  test("mounts cleanly alongside LoroSyncPlugin and survives destroy", async () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const aware = new CursorAwareness(doc.peerIdStr);

    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON({ type: "doc", content: [] }),
        schema,
        plugins: [
          LoroSyncPlugin({ doc }),
          LoroCursorPlugin(aware, {
            user: { name: "Local", color: "#0a0" },
          }),
        ],
      }),
    });

    try {
      // The plugin mounted without throwing.
      expect(view.isDestroyed).toBe(false);
      // Awareness has the local peer registered (no cursor yet — view not focused).
      // Just verify the plugin's setup ran.
    } finally {
      view.destroy();
      place.remove();
    }
    // After destroy, awareness's local state has been cleared by the
    // plugin's `destroy` hook (it calls `store.setLocal({})`).
    expect(aware.getLocal()?.anchor).toBeFalsy();
  });
});
