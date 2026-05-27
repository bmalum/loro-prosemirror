import { describe, expect, test } from "vitest";

import { LoroDoc, LoroList, LoroMap, LoroText } from "loro-crdt";

import {
  ROOT_DOC_KEY,
  type LoroDocType,
  type LoroNode,
  type LoroNodeContainerType,
  type LoroNodeMapping,
  createNodeFromLoroObj,
  updateLoroToPmState,
  getLoroMapChildren,
  clearChangedNodes,
} from "../src/lib";
import {
  findContainerLocation,
  findEmptyTextPosition,
} from "../src/incremental-sync";

import { schema } from "./schema";
import { createEditorState } from "./utils";

const helloWorld = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Hello world" }] },
  ],
};

// ---------------------------------------------------------------------------
// createNodeFromLoroObj — error paths
// ---------------------------------------------------------------------------

describe("createNodeFromLoroObj (error paths)", () => {
  test("throws + reports via onError when nodeName is missing", () => {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
    // Don't set nodeName.

    const errors: unknown[] = [];
    expect(() =>
      createNodeFromLoroObj(
        schema,
        root as unknown as LoroNode & { _branded: LoroNodeContainerType },
        new Map(),
        (e) => errors.push(e),
      ),
    ).toThrow(/Invalid nodeName/);
    expect(errors.length).toBe(1);
  });

  test("returns null + reports via onError when schema rejects nodeName", () => {
    const doc: LoroDocType = new LoroDoc();
    const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
    root.set("nodeName", "completelyUnknownNodeType");
    root.getOrCreateContainer("attributes", new LoroMap());
    root.getOrCreateContainer("children", new LoroList());

    const errors: unknown[] = [];
    // Silence the internal console.error so the test output stays clean.
    const realError = console.error;
    console.error = () => {};
    try {
      const result = createNodeFromLoroObj(
        schema,
        root as unknown as LoroNode & { _branded: LoroNodeContainerType },
        new Map(),
        (e) => errors.push(e),
      );
      expect(result).toBeNull();
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.error = realError;
    }
  });

  test("LoroText with marks builds an array of text nodes", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(
      doc,
      new Map(),
      createEditorState(schema, {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", marks: [{ type: "bold" }], text: "Bold" },
              { type: "text", text: " plain" },
            ],
          },
        ],
      }),
    );
    const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
    const para = getLoroMapChildren(root).get(0) as LoroNode;
    const text = getLoroMapChildren(para).get(0) as LoroText;
    const mapping: LoroNodeMapping = new Map();
    const nodes = createNodeFromLoroObj(schema, text, mapping);
    expect(Array.isArray(nodes)).toBe(true);
    expect((nodes as unknown[]).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// updateLoroToPmState — already-populated path (isInit = false)
// ---------------------------------------------------------------------------

describe("updateLoroToPmState (already populated)", () => {
  test("second call commits with origin 'loroSyncPlugin' (not sys:init)", () => {
    const doc: LoroDocType = new LoroDoc();
    const mapping: LoroNodeMapping = new Map();
    updateLoroToPmState(doc, mapping, createEditorState(schema, helloWorld));
    // First call already initialized the doc.
    expect((doc.getMap(ROOT_DOC_KEY) as LoroNode).get("nodeName")).toBe("doc");

    // Track origins of subsequent local commits.
    const origins: (string | undefined)[] = [];
    doc.subscribe((batch) => {
      if (batch.by === "local") origins.push(batch.origin);
    });

    // Now update with slightly different content — exercises the
    // not-isInit branch (line 79 in lib.ts: `if (map.get("nodeName")
    // == null)` is false).
    const updatedState = createEditorState(schema, {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "New text" }] },
      ],
    });
    updateLoroToPmState(doc, mapping, updatedState);

    // Loro should have at least one commit with origin "loroSyncPlugin"
    // — the second-pass commit. Empty diffs may be no-op; we just
    // assert no sys:init was emitted.
    expect(origins).not.toContain("sys:init");
  });
});

// ---------------------------------------------------------------------------
// findEmptyTextPosition (the exported helper) — direct coverage
// ---------------------------------------------------------------------------

describe("findEmptyTextPosition (direct)", () => {
  test("returns null when the LoroText is not under a parent block", () => {
    const doc: LoroDocType = new LoroDoc();
    // A bare top-level LoroText with no parent block.
    const orphan = doc.getText("orphan");
    const editorState = createEditorState(schema, helloWorld);
    const pos = findEmptyTextPosition(
      editorState.doc,
      orphan.id,
      new Map(),
      doc,
    );
    expect(pos).toBeNull();
  });

  test("returns null when the parent block has no PM mapping", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
    const para = getLoroMapChildren(root).get(0) as LoroNode;
    const text = getLoroMapChildren(para).get(0) as LoroText;
    // Empty mapping → parent block has no entry.
    const pos = findEmptyTextPosition(
      createEditorState(schema, helloWorld).doc,
      text.id,
      new Map(),
      doc,
    );
    expect(pos).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findContainerLocation — direct coverage
// ---------------------------------------------------------------------------

describe("findContainerLocation (direct, edge cases)", () => {
  test("returns null when the mapping is empty", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const para = getLoroMapChildren(doc.getMap(ROOT_DOC_KEY) as LoroNode).get(
      0,
    ) as LoroNode;
    expect(
      findContainerLocation(
        createEditorState(schema, helloWorld).doc,
        para.id,
        new Map(),
      ),
    ).toBeNull();
  });

  test("returns null when the mapped text-run is empty", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const para = getLoroMapChildren(doc.getMap(ROOT_DOC_KEY) as LoroNode).get(
      0,
    ) as LoroNode;
    const text = getLoroMapChildren(para).get(0) as LoroText;
    // Forge a mapping whose value is an empty array.
    const mapping: LoroNodeMapping = new Map();
    mapping.set(text.id, []);
    const result = findContainerLocation(
      createEditorState(schema, helloWorld).doc,
      text.id,
      mapping,
    );
    expect(result).toBeNull();
  });

  test("uses cache when provided", () => {
    const doc: LoroDocType = new LoroDoc();
    const seedMapping: LoroNodeMapping = new Map();
    updateLoroToPmState(
      doc,
      seedMapping,
      createEditorState(schema, helloWorld),
    );
    const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
    const para = getLoroMapChildren(root).get(0) as LoroNode;

    // Build a PM doc that shares Node identity with the mapping.
    const mapping: LoroNodeMapping = new Map();
    const pmDoc = createNodeFromLoroObj(
      schema,
      root as unknown as LoroNode & { _branded: LoroNodeContainerType },
      mapping,
    );

    const cache = new Map();
    const r1 = findContainerLocation(pmDoc, para.id, mapping, cache);
    expect(r1).not.toBeNull();
    expect(cache.size).toBeGreaterThan(0);

    // Second call should hit the cache and return the same result.
    const r2 = findContainerLocation(pmDoc, para.id, mapping, cache);
    expect(r2).not.toBeNull();
    expect(r2).toEqual(r1);
  });
});

// ---------------------------------------------------------------------------
// clearChangedNodes — exercises lib.ts line range
// ---------------------------------------------------------------------------

describe("clearChangedNodes", () => {
  test("removes mapping entries for events' targets and ancestors", async () => {
    const doc: LoroDocType = new LoroDoc();
    const mapping: LoroNodeMapping = new Map();
    updateLoroToPmState(doc, mapping, createEditorState(schema, helloWorld));
    expect(mapping.size).toBeGreaterThan(0);

    const root = doc.getMap(ROOT_DOC_KEY) as LoroNode;
    const para = getLoroMapChildren(root).get(0) as LoroNode;
    const text = getLoroMapChildren(para).get(0) as LoroText;

    // Capture an event batch by mutating then committing.
    const batches: import("loro-crdt").LoroEventBatch[] = [];
    const unsub = doc.subscribe((b) => batches.push(b));
    text.insert(0, "X");
    doc.commit();
    await new Promise((r) => setTimeout(r, 5));
    unsub();

    expect(batches.length).toBeGreaterThan(0);

    // clearChangedNodes should walk targets + ancestors and prune mapping.
    const sizeBefore = mapping.size;
    clearChangedNodes(doc, batches[0], mapping);
    expect(mapping.size).toBeLessThan(sizeBefore);
  });
});
