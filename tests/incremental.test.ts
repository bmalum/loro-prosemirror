import { describe, expect, test } from "vitest";

import { LoroDoc, type LoroEventBatch, LoroMap, LoroText } from "loro-crdt";
import { TextSelection } from "prosemirror-state";

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
 * Build a `(LoroDoc, EditorState, mapping)` triple where the Loro doc and
 * the editor state are in sync. The mapping uses identity-bound PM Node
 * references so `findContainerLocation` can resolve them by `===`.
 */
function buildSyncedFixture(content: any) {
  const editorState = createEditorState(schema, content);
  const loroDoc: LoroDocType = new LoroDoc();
  const seedMapping: LoroNodeMapping = new Map();
  updateLoroToPmState(loroDoc, seedMapping, editorState);

  const innerDoc = loroDoc.getMap(ROOT_DOC_KEY);
  const node = createNodeFromLoroObj(
    schema,
    innerDoc as LoroMap<LoroNodeContainerType>,
    new Map(),
  );
  const syncedState = createEditorState(schema, node.toJSON());

  // Bind containers to the editor-state Node instances by structural walk.
  const mapping = rebindMapping(syncedState.doc, innerDoc as LoroNode);
  return { loroDoc, editorState: syncedState, mapping };
}

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
        if (pmIndex >= pmNode.childCount) break;
        walk(pmNode.child(pmIndex), loroChild as LoroNode);
        pmIndex++;
      } else {
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

/**
 * Helper that captures the next event batch produced by a Loro mutation.
 * Returns `[batches, dispose]` so tests can subscribe once and snapshot.
 */
function captureEvents(loroDoc: LoroDocType): {
  batches: LoroEventBatch[];
  dispose: () => void;
} {
  const batches: LoroEventBatch[] = [];
  const unsubscribe = loroDoc.subscribe((batch) => batches.push(batch));
  return { batches, dispose: unsubscribe };
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
    expect(firstLoc!.pos).toBe(0);
    expect(secondLoc!.pos).toBe(editorState.doc.child(0).nodeSize);
  });

  test("locates a text container at the parent block's content offset", () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const firstParagraph = getLoroMapChildren(innerDoc).get(0) as LoroNode;
    const firstText = getLoroMapChildren(firstParagraph).get(0)!;

    const loc = findContainerLocation(editorState.doc, firstText.id, mapping);
    expect(loc).not.toBeNull();
    expect(loc!.isText).toBe(true);
    expect(loc!.pos).toBe(1);
  });

  test("returns null for a container that has no PM mapping yet", () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const newPara = insertLoroMap(getLoroMapChildren(innerDoc), "paragraph");
    insertLoroText(getLoroMapChildren(newPara));
    loroDoc.commit();

    const loc = findContainerLocation(editorState.doc, newPara.id, mapping);
    expect(loc).toBeNull();
  });
});

describe("loroEventBatchToTransaction (text)", () => {
  test("translates an insert at the start of a paragraph", async () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const { batches, dispose } = captureEvents(loroDoc);

    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const firstPara = getLoroMapChildren(innerDoc).get(0) as LoroNode;
    const firstText = getLoroMapChildren(firstPara).get(0) as LoroText;
    firstText.insert(0, "Oh ");
    loroDoc.commit();
    await oneMs();
    dispose();

    expect(batches.length).toBeGreaterThan(0);
    const tr = loroEventBatchToTransaction(
      editorState,
      batches[0],
      mapping,
      loroDoc,
    );
    expect(tr).not.toBeNull();
    expect(tr!.docChanged).toBe(true);

    const newState = editorState.apply(tr!);
    expect(newState.doc.child(0).textContent).toBe("Oh Hello world");
  });

  test("translates an insert in the middle of a paragraph", async () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const { batches, dispose } = captureEvents(loroDoc);

    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const firstText = getLoroMapChildren(
      getLoroMapChildren(innerDoc).get(0) as LoroNode,
    ).get(0) as LoroText;
    firstText.insert(5, " there");
    loroDoc.commit();
    await oneMs();
    dispose();

    const tr = loroEventBatchToTransaction(
      editorState,
      batches[0],
      mapping,
      loroDoc,
    );
    expect(tr).not.toBeNull();
    const newState = editorState.apply(tr!);
    expect(newState.doc.child(0).textContent).toBe("Hello there world");
  });

  test("translates a delete in the middle of a paragraph", async () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const { batches, dispose } = captureEvents(loroDoc);

    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const firstText = getLoroMapChildren(
      getLoroMapChildren(innerDoc).get(0) as LoroNode,
    ).get(0) as LoroText;
    firstText.delete(5, 6); // delete " world"
    loroDoc.commit();
    await oneMs();
    dispose();

    const tr = loroEventBatchToTransaction(
      editorState,
      batches[0],
      mapping,
      loroDoc,
    );
    expect(tr).not.toBeNull();
    const newState = editorState.apply(tr!);
    expect(newState.doc.child(0).textContent).toBe("Hello");
  });

  test("translates an edit in a non-first paragraph", async () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const { batches, dispose } = captureEvents(loroDoc);

    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const secondText = getLoroMapChildren(
      getLoroMapChildren(innerDoc).get(1) as LoroNode,
    ).get(0) as LoroText;
    secondText.insert(6, " paragraph");
    loroDoc.commit();
    await oneMs();
    dispose();

    const tr = loroEventBatchToTransaction(
      editorState,
      batches[0],
      mapping,
      loroDoc,
    );
    expect(tr).not.toBeNull();
    const newState = editorState.apply(tr!);
    expect(newState.doc.child(0).textContent).toBe("Hello world");
    expect(newState.doc.child(1).textContent).toBe("Second paragraph");
  });

  test("preserves a local cursor through a remote insert before it", async () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);

    // Place the local cursor at the end of the first paragraph (pos 12).
    const cursorPos = 1 + "Hello world".length;
    const stateWithSelection = editorState.apply(
      editorState.tr.setSelection(
        TextSelection.create(editorState.doc, cursorPos),
      ),
    );
    expect(stateWithSelection.selection.from).toBe(cursorPos);

    const { batches, dispose } = captureEvents(loroDoc);
    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const firstText = getLoroMapChildren(
      getLoroMapChildren(innerDoc).get(0) as LoroNode,
    ).get(0) as LoroText;
    firstText.insert(0, "Oh ");
    loroDoc.commit();
    await oneMs();
    dispose();

    const tr = loroEventBatchToTransaction(
      stateWithSelection,
      batches[0],
      mapping,
      loroDoc,
    );
    expect(tr).not.toBeNull();
    const newState = stateWithSelection.apply(tr!);
    // PM's selection mapping must shift the cursor by 3 ("Oh ".length).
    expect(newState.selection.from).toBe(cursorPos + 3);
    expect(newState.doc.child(0).textContent).toBe("Oh Hello world");
  });

  test("translates a mark-add as an AddMarkStep over the affected range", async () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const { batches, dispose } = captureEvents(loroDoc);

    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const firstText = getLoroMapChildren(
      getLoroMapChildren(innerDoc).get(0) as LoroNode,
    ).get(0) as LoroText;
    // Bold "world".
    firstText.mark({ start: 6, end: 11 }, "bold", true);
    loroDoc.commit();
    await oneMs();
    dispose();

    const tr = loroEventBatchToTransaction(
      editorState,
      batches[0],
      mapping,
      loroDoc,
    );
    expect(tr).not.toBeNull();
    const newState = editorState.apply(tr!);

    // First paragraph should now have three text nodes: "Hello ", bold "world", "".
    const firstPara = newState.doc.child(0);
    let foundBold = false;
    firstPara.forEach((child) => {
      if (
        child.text === "world" &&
        child.marks.some((m) => m.type.name === "bold")
      ) {
        foundBold = true;
      }
    });
    expect(foundBold).toBe(true);
  });

  test("translates a mark-remove (null attribute) as a RemoveMarkStep", async () => {
    const fixtureContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            {
              type: "text",
              text: "world",
              marks: [{ type: "bold" }],
            },
          ],
        },
      ],
    };
    const { loroDoc, editorState, mapping } =
      buildSyncedFixture(fixtureContent);
    const { batches, dispose } = captureEvents(loroDoc);

    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const firstText = getLoroMapChildren(
      getLoroMapChildren(innerDoc).get(0) as LoroNode,
    ).get(0) as LoroText;
    // Unbold "world".
    firstText.unmark({ start: 6, end: 11 }, "bold");
    loroDoc.commit();
    await oneMs();
    dispose();

    const tr = loroEventBatchToTransaction(
      editorState,
      batches[0],
      mapping,
      loroDoc,
    );
    expect(tr).not.toBeNull();
    const newState = editorState.apply(tr!);
    const firstPara = newState.doc.child(0);
    let anyBold = false;
    firstPara.forEach((child) => {
      if (child.marks.some((m) => m.type.name === "bold")) anyBold = true;
    });
    expect(anyBold).toBe(false);
    expect(firstPara.textContent).toBe("Hello world");
  });

  test("handles a remote edit imported into a peer", async () => {
    // Two peers synced. Peer B types something. Peer A imports the update.
    // The import-induced event batch on A must translate cleanly into PM
    // steps that bring A's editor state in line with A's post-import Loro.
    const docA: LoroDocType = new LoroDoc();
    const docB: LoroDocType = new LoroDoc();

    const seedState = createEditorState(schema, helloWorldDoc);
    const seedMapping: LoroNodeMapping = new Map();
    updateLoroToPmState(docA, seedMapping, seedState);
    docB.import(docA.export({ mode: "snapshot" }));

    const innerA = docA.getMap(ROOT_DOC_KEY);
    const nodeA = createNodeFromLoroObj(
      schema,
      innerA as LoroMap<LoroNodeContainerType>,
      new Map(),
    );
    const editorStateA = createEditorState(schema, nodeA.toJSON());
    const mappingA = rebindMapping(editorStateA.doc, innerA as LoroNode);

    // B makes a remote edit.
    const innerB = docB.getMap(ROOT_DOC_KEY);
    const textB = getLoroMapChildren(
      getLoroMapChildren(innerB as LoroNode).get(0) as LoroNode,
    ).get(0) as LoroText;
    textB.insert(11, " from B");
    docB.commit();

    // A imports B's update. Capture only the import-induced batch so a
    // possible re-emission of A's earlier local commits doesn't confuse us.
    const batches: LoroEventBatch[] = [];
    const unsub = docA.subscribe((batch) => {
      if (batch.by === "import") batches.push(batch);
    });
    docA.import(docB.export({ mode: "update", from: docA.version() }));
    await oneMs();
    unsub();

    expect(batches.length).toBeGreaterThan(0);
    const tr = loroEventBatchToTransaction(
      editorStateA,
      batches[0],
      mappingA,
      docA,
    );
    expect(tr).not.toBeNull();
    const newState = editorStateA.apply(tr!);
    expect(newState.doc.child(0).textContent).toBe("Hello world from B");
  });
});

// ---------------------------------------------------------------------------
// Phase 3: list & map diffs (block insert/delete, attribute changes)
// ---------------------------------------------------------------------------

describe("loroEventBatchToTransaction (list)", () => {
  test("inserts a remote-added paragraph at the end of the doc", async () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const { batches, dispose } = captureEvents(loroDoc);

    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const newPara = insertLoroMap(getLoroMapChildren(innerDoc), "paragraph");
    const newText = insertLoroText(getLoroMapChildren(newPara));
    newText.insert(0, "Third");
    loroDoc.commit();
    await oneMs();
    dispose();

    expect(batches.length).toBeGreaterThan(0);
    const tr = loroEventBatchToTransaction(
      editorState,
      batches[0],
      mapping,
      loroDoc,
    );
    expect(tr).not.toBeNull();
    const newState = editorState.apply(tr!);
    expect(newState.doc.childCount).toBe(3);
    expect(newState.doc.child(2).type.name).toBe("paragraph");
    expect(newState.doc.child(2).textContent).toBe("Third");
    // Existing paragraphs unchanged.
    expect(newState.doc.child(0).textContent).toBe("Hello world");
    expect(newState.doc.child(1).textContent).toBe("Second");
  });

  test("inserts a remote-added paragraph between existing paragraphs", async () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const { batches, dispose } = captureEvents(loroDoc);

    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const docChildren = getLoroMapChildren(innerDoc);
    // Insert at index 1 (between the two existing paragraphs).
    const newPara = docChildren.insertContainer(1, new LoroMap()) as LoroNode;
    newPara.set("nodeName", "paragraph");
    getLoroMapChildren(newPara);
    const attrs = newPara.getOrCreateContainer("attributes", new LoroMap());
    void attrs;
    const newText = insertLoroText(getLoroMapChildren(newPara));
    newText.insert(0, "Middle");
    loroDoc.commit();
    await oneMs();
    dispose();

    const tr = loroEventBatchToTransaction(
      editorState,
      batches[0],
      mapping,
      loroDoc,
    );
    expect(tr).not.toBeNull();
    const newState = editorState.apply(tr!);
    expect(newState.doc.childCount).toBe(3);
    expect(newState.doc.child(0).textContent).toBe("Hello world");
    expect(newState.doc.child(1).textContent).toBe("Middle");
    expect(newState.doc.child(2).textContent).toBe("Second");
  });

  test("deletes a remote-removed paragraph", async () => {
    const { loroDoc, editorState, mapping } = buildSyncedFixture(helloWorldDoc);
    const { batches, dispose } = captureEvents(loroDoc);

    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    getLoroMapChildren(innerDoc).delete(0, 1);
    loroDoc.commit();
    await oneMs();
    dispose();

    const tr = loroEventBatchToTransaction(
      editorState,
      batches[0],
      mapping,
      loroDoc,
    );
    expect(tr).not.toBeNull();
    const newState = editorState.apply(tr!);
    expect(newState.doc.childCount).toBe(1);
    expect(newState.doc.child(0).textContent).toBe("Second");
  });

  test("inserts a list item into an existing bulletList", async () => {
    const fixture = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "One" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const { loroDoc, editorState, mapping } = buildSyncedFixture(fixture);
    const { batches, dispose } = captureEvents(loroDoc);

    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const bulletList = getLoroMapChildren(innerDoc).get(0) as LoroNode;
    const items = getLoroMapChildren(bulletList);
    const newItem = insertLoroMap(items, "listItem");
    const newPara = insertLoroMap(getLoroMapChildren(newItem), "paragraph");
    const newText = insertLoroText(getLoroMapChildren(newPara));
    newText.insert(0, "Two");
    loroDoc.commit();
    await oneMs();
    dispose();

    const tr = loroEventBatchToTransaction(
      editorState,
      batches[0],
      mapping,
      loroDoc,
    );
    expect(tr).not.toBeNull();
    const newState = editorState.apply(tr!);
    const list = newState.doc.child(0);
    expect(list.type.name).toBe("bulletList");
    expect(list.childCount).toBe(2);
    expect(list.child(1).child(0).textContent).toBe("Two");
  });
});

describe("loroEventBatchToTransaction (map)", () => {
  test("translates an attribute change into setNodeMarkup", async () => {
    const fixture = {
      type: "doc",
      content: [
        {
          type: "noteTitle",
          attrs: { emoji: "🦜" },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Body" }],
        },
      ],
    };
    const { loroDoc, editorState, mapping } = buildSyncedFixture(fixture);
    const { batches, dispose } = captureEvents(loroDoc);

    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const titleBlock = getLoroMapChildren(innerDoc).get(0) as LoroNode;
    const titleAttrs = titleBlock.getOrCreateContainer(
      "attributes",
      new LoroMap(),
    );
    titleAttrs.set("emoji", "🐦");
    loroDoc.commit();
    await oneMs();
    dispose();

    const tr = loroEventBatchToTransaction(
      editorState,
      batches[0],
      mapping,
      loroDoc,
    );
    expect(tr).not.toBeNull();
    const newState = editorState.apply(tr!);
    expect(newState.doc.child(0).attrs.emoji).toBe("🐦");
    // Content of the title preserved.
    expect(newState.doc.child(0).textContent).toBe("Title");
  });

  test("translates an attribute removal", async () => {
    const fixture = {
      type: "doc",
      content: [
        {
          type: "noteTitle",
          attrs: { emoji: "🦜" },
          content: [{ type: "text", text: "Title" }],
        },
      ],
    };
    const { loroDoc, editorState, mapping } = buildSyncedFixture(fixture);
    const { batches, dispose } = captureEvents(loroDoc);

    const innerDoc = loroDoc.getMap(ROOT_DOC_KEY) as LoroNode;
    const titleBlock = getLoroMapChildren(innerDoc).get(0) as LoroNode;
    const titleAttrs = titleBlock.getOrCreateContainer(
      "attributes",
      new LoroMap(),
    );
    titleAttrs.delete("emoji");
    loroDoc.commit();
    await oneMs();
    dispose();

    const tr = loroEventBatchToTransaction(
      editorState,
      batches[0],
      mapping,
      loroDoc,
    );
    expect(tr).not.toBeNull();
    const newState = editorState.apply(tr!);
    // Schema default for emoji is "".
    expect(newState.doc.child(0).attrs.emoji).toBe("");
  });
});
