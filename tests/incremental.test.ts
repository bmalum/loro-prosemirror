import { describe, expect, test } from "vitest";

import { LoroDoc, LoroMap } from "loro-crdt";

import {
  findContainerLocation,
  loroEventBatchToTransaction,
} from "../src/incremental-sync";
import {
  ROOT_DOC_KEY,
  createNodeFromLoroObj,
  getLoroMapChildren,
  type LoroDocType,
  type LoroNode,
  type LoroNodeContainerType,
  type LoroNodeMapping,
  updateLoroToPmState,
} from "../src/lib";

import { schema } from "./schema";
import {
  createEditorState,
  insertLoroMap,
  insertLoroText,
  oneMs,
  setupLoroMap,
} from "./utils";

const helloWorldDoc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Hello world" }],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "Second" }],
    },
  ],
};

/**
 * Build a `(LoroDoc, EditorState, mapping)` triple where the Loro doc and the
 * editor state are in sync. This is the precondition for incremental sync:
 * the mapping is fresh, every container in Loro has a PM Node twin.
 */
function buildSyncedFixture(content: any) {
  const editorState = createEditorState(schema, content);
  const loroDoc: LoroDocType = new LoroDoc();
  const mapping: LoroNodeMapping = new Map();
  updateLoroToPmState(loroDoc, mapping, editorState);

  // Re-create the PM doc from Loro to populate the mapping with the same
  // Node references that the next call to `createNodeFromLoroObj` would.
  const innerDoc = loroDoc.getMap(ROOT_DOC_KEY);
  const node = createNodeFromLoroObj(
    schema,
    innerDoc as LoroMap<LoroNodeContainerType>,
    mapping,
  );
  const syncedState = createEditorState(schema, node.toJSON());

  // Repopulate the mapping against the freshly created PM nodes used by the
  // editor state, so that mapping → editor state is in agreement.
  const repopMapping: LoroNodeMapping = new Map();
  createNodeFromLoroObj(
    schema,
    innerDoc as LoroMap<LoroNodeContainerType>,
    repopMapping,
  );

  // The mapping built by the second create call references nodes that are
  // *equivalent* to the editor state nodes but not identical. To get
  // identity-based lookup, walk the editor state and re-bind containers in
  // PM order.
  const rebound = rebindMapping(syncedState.doc, innerDoc as LoroNode);

  return { loroDoc, editorState: syncedState, mapping: rebound };
}

/**
 * Walk a PM doc and a Loro inner-doc tree in lockstep, binding each Loro
 * container ID to the PM node that occupies the same slot. Used by the
 * test fixture to produce a mapping whose Node references are identical
 * (===) to the ones inside `pmDoc`.
 */
function rebindMapping(
  pmDoc: import("prosemirror-model").Node,
  loroInner: LoroNode,
): LoroNodeMapping {
  const mapping: LoroNodeMapping = new Map();

  function walk(pmNode: import("prosemirror-model").Node, loroNode: LoroNode) {
    mapping.set(loroNode.id, pmNode);
    const loroChildren = getLoroMapChildren(loroNode);
    let pmIndex = 0;
    for (let li = 0; li < loroChildren.length; li++) {
      const loroChild = loroChildren.get(li);
      if (loroChild instanceof LoroMap) {
        // Block child: find the matching PM child.
        if (pmIndex >= pmNode.childCount) {
          break;
        }
        walk(pmNode.child(pmIndex), loroChild as LoroNode);
        pmIndex++;
      } else {
        // Inline text run: collect contiguous PM text nodes into an array
        // bound to this LoroText container.
        const textNodes: import("prosemirror-model").Node[] = [];
        while (pmIndex < pmNode.childCount && pmNode.child(pmIndex).isText) {
          textNodes.push(pmNode.child(pmIndex));
          pmIndex++;
        }
        if (textNodes.length > 0) {
          mapping.set(loroChild.id, textNodes);
        }
      }
    }
  }

  walk(pmDoc, loroInner);
  return mapping;
}

describe("findContainerLocation", () => {
  test("locates a block container by identity", () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const children = getLoroMapChildren(innerDoc);
    const firstParagraph = children.get(0) as LoroNode;
    const secondParagraph = children.get(1) as LoroNode;

    const firstLoc = findContainerLocation(
      editorState.doc,
      firstParagraph.id,
      mapping,
    );
    const secondLoc = findContainerLocation(
      editorState.doc,
      secondParagraph.id,
      mapping,
    );

    expect(firstLoc).not.toBeNull();
    expect(secondLoc).not.toBeNull();
    expect(firstLoc!.isText).toBe(false);
    expect(secondLoc!.isText).toBe(false);
    // First paragraph is at position 0 in the doc.
    expect(firstLoc!.pos).toBe(0);
    // Second paragraph follows the first (which has 11 text chars + open/close = 13).
    expect(secondLoc!.pos).toBe(editorState.doc.child(0).nodeSize);
  });

  test("locates a text container as the parent block's content offset", () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const firstParagraph = getLoroMapChildren(innerDoc).get(0) as LoroNode;
    const firstText = getLoroMapChildren(firstParagraph).get(0)!;

    const loc = findContainerLocation(editorState.doc, firstText.id, mapping);
    expect(loc).not.toBeNull();
    expect(loc!.isText).toBe(true);
    // Parent paragraph is at pos 0, its content starts at pos 1.
    expect(loc!.pos).toBe(1);
  });

  test("returns null for a container that has no PM mapping yet", () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    // Create a brand-new container in Loro but do NOT register it in the
    // mapping — this simulates a container that has just arrived from a
    // remote update before the parent walk has materialised it.
    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const newPara = insertLoroMap(getLoroMapChildren(innerDoc), "paragraph");
    insertLoroText(getLoroMapChildren(newPara));
    loroDoc.commit();

    const loc = findContainerLocation(editorState.doc, newPara.id, mapping);
    expect(loc).toBeNull();
  });
});

describe("loroEventBatchToTransaction (Phase 1)", () => {
  test("returns a no-op transaction for an empty batch", () => {
    const { editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const tr = loroEventBatchToTransaction(
      editorState,
      {
        by: "import",
        events: [],
        from: [],
        to: [],
      },
      mapping,
    );
    expect(tr).not.toBeNull();
    expect(tr!.docChanged).toBe(false);
  });

  test("returns null when any event has not yet been implemented", async () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const firstPara = getLoroMapChildren(innerDoc).get(0) as LoroNode;
    const firstText = getLoroMapChildren(firstPara).get(0);

    // Capture the next event batch and feed it to the translator.
    const batches: import("loro-crdt").LoroEventBatch[] = [];
    const unsubscribe = loroDoc.subscribe((batch) => batches.push(batch));

    (firstText as import("loro-crdt").LoroText).insert(5, "X");
    loroDoc.commit();
    await oneMs();
    unsubscribe();

    expect(batches.length).toBeGreaterThan(0);
    const tr = loroEventBatchToTransaction(editorState, batches[0], mapping);
    // Phase 1 has no diff translators implemented, so any non-empty diff
    // returns null — caller will fall back to full replace.
    expect(tr).toBeNull();
  });
});
