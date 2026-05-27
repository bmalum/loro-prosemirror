import { describe, expect, test } from "vitest";

// @vitest-environment jsdom

import { LoroDoc, LoroMap } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { LoroSyncPlugin } from "../src/sync-plugin";
import { loroSyncPluginKey, type LoroSyncEvent } from "../src/sync-plugin-key";
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
// End-to-end: PM edit -> Loro write (doc-changed path)
// ---------------------------------------------------------------------------

describe("LoroSyncPlugin (PM->Loro write path)", () => {
  test("user typing fires doc-changed apply branch and commits Loro", async () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));

    // Capture local Loro updates emitted as a result of PM edits.
    const localUpdates: number[] = [];
    doc.subscribeLocalUpdates((bytes) => {
      localUpdates.push(bytes.byteLength);
    });

    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON({ type: "doc", content: [] }),
        schema,
        plugins: [LoroSyncPlugin({ doc })],
      }),
    });
    try {
      // Init has run; localUpdates should still be empty (post-hydrate
      // contract — see the post_hydrate_reconcile.test.js spec from
      // super_loop).
      const beforeUserTx = localUpdates.length;

      // User-style insert.
      view.dispatch(view.state.tr.insertText("X", 1));
      await new Promise((r) => setTimeout(r, 5));

      // Loro should now have at least one new local update.
      expect(localUpdates.length).toBeGreaterThan(beforeUserTx);

      // The Loro doc reflects the typed character.
      const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
      const para = getLoroMapChildren(root).get(0) as LoroNode;
      const text = getLoroMapChildren(para).get(
        0,
      ) as import("loro-crdt").LoroText;
      expect(text.toString()).toContain("X");
    } finally {
      view.destroy();
      place.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: Loro -> PM remote import (incremental path)
// ---------------------------------------------------------------------------

describe("LoroSyncPlugin (Loro->PM remote import)", () => {
  test("a remote text insert imported into the local doc updates PM via the incremental path", async () => {
    // Two peers sharing a Loro doc state.
    const docA: LoroDocType = new LoroDoc();
    const docB: LoroDocType = new LoroDoc();
    updateLoroToPmState(docA, new Map(), createEditorState(schema, helloWorld));
    docB.import(docA.export({ mode: "snapshot" }));

    const events: LoroSyncEvent[] = [];
    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON({ type: "doc", content: [] }),
        schema,
        plugins: [
          LoroSyncPlugin({
            doc: docB,
            onSyncEvent: (e) => events.push(e),
          }),
        ],
      }),
    });
    try {
      // Peer A inserts text.
      const root = docA.getMap(ROOT_DOC_KEY) as LoroNode;
      const text = getLoroMapChildren(
        getLoroMapChildren(root).get(0) as LoroNode,
      ).get(0) as import("loro-crdt").LoroText;
      text.insert(0, "Z");
      docA.commit();

      // Sync to B.
      docB.import(docA.export({ mode: "update", from: docB.oplogVersion() }));
      await new Promise((r) => setTimeout(r, 10));

      // The incremental path should have fired.
      const incremental = events.find((e) => e.kind === "incremental");
      expect(incremental).toBeDefined();

      // PM should reflect the insert.
      expect(view.state.doc.textContent).toContain("Z");
    } finally {
      view.destroy();
      place.remove();
    }
  });

  test("checkout-marked event batches route to the fallback path", async () => {
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
      // Snapshot the current frontiers; type something; checkout
      // back to the snapshot to produce a checkout-marked event.
      const before = doc.frontiers();
      const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
      const text = getLoroMapChildren(
        getLoroMapChildren(root).get(0) as LoroNode,
      ).get(0) as import("loro-crdt").LoroText;
      text.insert(0, "Q");
      doc.commit();
      await new Promise((r) => setTimeout(r, 5));

      // Reset event log to focus on the checkout itself.
      events.length = 0;

      doc.checkout(before);
      await new Promise((r) => setTimeout(r, 10));

      const fallback = events.find((e) => e.kind === "fallback");
      expect(fallback).toBeDefined();
      expect(
        fallback && fallback.kind === "fallback" ? fallback.reason : null,
      ).toBe("checkout");
    } finally {
      view.destroy();
      place.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// containerId path
// ---------------------------------------------------------------------------

describe("LoroSyncPlugin (containerId scoping)", () => {
  test("mounts against a sub-container instead of the root doc map", async () => {
    const doc: LoroDocType = new LoroDoc();
    // Pre-populate a non-root container with PM-style structure.
    const sub = (doc as unknown as { getMap: (k: string) => LoroMap }).getMap(
      "editor-1",
    ) as unknown as LoroNode;
    const subState = createEditorState(schema, helloWorld);
    updateLoroToPmState(doc, new Map(), subState, sub.id);

    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON({ type: "doc", content: [] }),
        schema,
        plugins: [LoroSyncPlugin({ doc, containerId: sub.id })],
      }),
    });
    try {
      // PM should reflect the sub-container's content.
      expect(view.state.doc.textContent).toBe("Hello world");
    } finally {
      view.destroy();
      place.remove();
    }
  });

  test("init throws (caught) and emits init-error when containerId is missing", () => {
    const doc: LoroDocType = new LoroDoc();
    // ContainerID for a container that doesn't exist in this doc.
    const fakeId = "cid:0@111:Map" as never;

    const events: LoroSyncEvent[] = [];
    const realError = console.error;
    console.error = () => {};
    try {
      const place = document.createElement("div");
      document.body.appendChild(place);
      const view = new EditorView(place, {
        state: EditorState.create({
          doc: schema.nodeFromJSON({ type: "doc", content: [] }),
          schema,
          plugins: [
            LoroSyncPlugin({
              doc,
              containerId: fakeId,
              onSyncEvent: (e) => events.push(e),
            }),
          ],
        }),
      });
      // init's throw was caught by view()'s try/catch; editor still mounts.
      expect(view.isDestroyed).toBe(false);
      const initError = events.find(
        (e) => e.kind === "error" && e.phase === "init",
      );
      expect(initError).toBeDefined();
      view.destroy();
      place.remove();
    } finally {
      console.error = realError;
    }
  });
});

// ---------------------------------------------------------------------------
// Local-undo origin path
// ---------------------------------------------------------------------------

describe("LoroSyncPlugin (event.by=local origin=undo passes through)", () => {
  test("a local commit with origin 'undo' is processed (not skipped)", async () => {
    // The plugin's filter is:
    //   if (event.by === "local" && event.origin !== "undo") return;
    // We simulate a local-but-undo commit by setting origin="undo" and
    // verify the incremental path fires.
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
      events.length = 0;
      const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
      const text = getLoroMapChildren(
        getLoroMapChildren(root).get(0) as LoroNode,
      ).get(0) as import("loro-crdt").LoroText;
      text.insert(0, "U");
      // Commit with origin "undo" — simulates an UndoManager.undo() pop.
      doc.commit({ origin: "undo" });
      await new Promise((r) => setTimeout(r, 10));

      const handled = events.find(
        (e) => e.kind === "incremental" || e.kind === "fallback",
      );
      expect(handled).toBeDefined();
    } finally {
      view.destroy();
      place.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// onSyncEvent hook: the catch path
// ---------------------------------------------------------------------------

describe("LoroSyncPlugin (onSyncEvent throws are swallowed)", () => {
  test("a throwing onSyncEvent does not break the dispatch flow", async () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));

    let onSyncCalled = 0;
    const realError = console.error;
    console.error = () => {};
    try {
      const place = document.createElement("div");
      document.body.appendChild(place);
      const view = new EditorView(place, {
        state: EditorState.create({
          doc: schema.nodeFromJSON({ type: "doc", content: [] }),
          schema,
          plugins: [
            LoroSyncPlugin({
              doc,
              onSyncEvent: () => {
                onSyncCalled++;
                throw new Error("test: sync hook threw");
              },
            }),
          ],
        }),
      });
      try {
        // The init dispatch fires onSyncEvent(init). Throws shouldn't
        // tear down the editor.
        expect(view.isDestroyed).toBe(false);
        expect(onSyncCalled).toBeGreaterThan(0);
      } finally {
        view.destroy();
        place.remove();
      }
    } finally {
      console.error = realError;
    }
  });
});
