import {
  type Container,
  type ContainerID,
  type Delta,
  isContainer,
  LoroList,
  LoroMap,
  type LoroEvent,
  type LoroEventBatch,
  LoroText,
  type MapDiff,
  type TextDiff,
  type Value,
} from "loro-crdt";
import { Fragment, type Mark, type Node, type Schema } from "prosemirror-model";
import { type EditorState, type Transaction } from "prosemirror-state";

import {
  ATTRIBUTES_KEY,
  createNodeFromLoroObj,
  type LoroDocType,
  type LoroNodeContainerType,
  type LoroNodeMapping,
  NODE_NAME_KEY,
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING,
} from "./lib";

/**
 * Information about where a Loro container resides in the ProseMirror tree.
 */
export interface ContainerLocation {
  /**
   * The PM Node bound to this container. For a `LoroText` this is the array
   * of inline text nodes (PM stores rich text as a sequence of text nodes,
   * each carrying its own marks).
   */
  node: Node | Node[];
  /**
   * The absolute PM position of `node`. For a non-text container it is the
   * position of the node itself (its opening token). For a `LoroText` it is
   * the position of the first character of the text run inside its parent
   * block, so that text-delta offsets compose 1:1 with PM positions.
   */
  pos: number;
  /** `true` when the container is a `LoroText` (mapped to `Node[]`). */
  isText: boolean;
}

/**
 * Find the position of a Loro container inside a ProseMirror doc.
 *
 * Returns `null` when the container has no PM mapping yet — for example when
 * a brand-new container has just arrived via a remote update and the parent
 * has not been re-walked, or when a `LoroText` has been emptied and pruned
 * from the mapping by `updateLoroToPmState`. Callers handling text events
 * should fall back to {@link findEmptyTextPosition} in that case.
 */
export function findContainerLocation(
  doc: Node,
  containerId: ContainerID,
  mapping: LoroNodeMapping,
): ContainerLocation | null {
  const mapped = mapping.get(containerId);
  if (mapped == null) {
    return null;
  }

  if (Array.isArray(mapped)) {
    if (mapped.length === 0) {
      return null;
    }
    const firstText = mapped[0];
    let runStart: number | null = null;
    doc.descendants((node, pos) => {
      if (runStart != null) {
        return false;
      }
      let offset = 0;
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child === firstText) {
          // pos = position of `node`; pos + 1 = inside opening token;
          // + offset accounts for siblings that precede the text run.
          runStart = pos + 1 + offset;
          return false;
        }
        offset += child.nodeSize;
      }
      return true;
    });
    if (runStart == null) {
      return null;
    }
    return { node: mapped, pos: runStart, isText: true };
  }

  if (mapped === doc) {
    return { node: mapped, pos: 0, isText: false };
  }

  let foundPos: number | null = null;
  doc.descendants((node, pos) => {
    if (foundPos != null) {
      return false;
    }
    if (node === mapped) {
      foundPos = pos;
      return false;
    }
    return true;
  });
  if (foundPos == null) {
    return null;
  }
  return { node: mapped, pos: foundPos, isText: false };
}

/**
 * Resolve the PM position of a `LoroText` whose mapping entry is missing
 * (typically because `updateLoroToPmState` pruned it after the LoroText
 * was fully emptied).
 *
 * The position is computed by walking the parent block's children list in
 * Loro and summing the PM `nodeSize` of the preceding mapped children.
 *
 * IMPORTANT: this function must NOT be called when the parent block's
 * children list has been mutated earlier in the same event batch — the
 * walk uses Loro's post-batch state but the returned position is in
 * pre-batch PM coordinates, and a sibling insert/delete in this batch
 * would silently shift the offset. Callers must guard with
 * `parentTouchedInBatch` (see {@link loroEventBatchToTransaction}).
 *
 * Returns `null` if the parent block is itself unmapped or the text
 * container is no longer in its parent.
 */
export function findEmptyTextPosition(
  pmDoc: Node,
  textId: ContainerID,
  mapping: LoroNodeMapping,
  loroDoc: LoroDocType,
): number | null {
  const text = loroDoc.getContainerById(textId);
  if (!(text instanceof LoroText)) {
    return null;
  }
  const parentList = text.parent();
  if (!(parentList instanceof LoroList)) {
    return null;
  }
  const parentBlock = parentList.parent();
  if (!(parentBlock instanceof LoroMap)) {
    return null;
  }

  const blockLoc = findContainerLocation(pmDoc, parentBlock.id, mapping);
  if (blockLoc == null || blockLoc.isText || Array.isArray(blockLoc.node)) {
    return null;
  }

  let textIdx = -1;
  for (let i = 0; i < parentList.length; i++) {
    const sibling = parentList.get(i);
    if (isContainer(sibling) && sibling.id === textId) {
      textIdx = i;
      break;
    }
  }
  if (textIdx === -1) {
    return null;
  }

  let offset = 0;
  for (let i = 0; i < textIdx; i++) {
    const sibling = parentList.get(i);
    if (!isContainer(sibling)) {
      return null;
    }
    const siblingMapped = mapping.get(sibling.id);
    if (siblingMapped == null) {
      // Another empty/unmapped LoroText contributes 0 to the offset.
      continue;
    }
    if (Array.isArray(siblingMapped)) {
      for (const n of siblingMapped) {
        offset += n.nodeSize;
      }
    } else {
      offset += siblingMapped.nodeSize;
    }
  }

  const isRoot = blockLoc.node === pmDoc;
  return (isRoot ? blockLoc.pos : blockLoc.pos + 1) + offset;
}

/**
 * Translate a `LoroEventBatch` into a ProseMirror `Transaction`.
 *
 * Returns `null` when any event in the batch cannot be translated — the
 * caller MUST fall back to a full document replace in that case so the
 * doc never diverges from Loro.
 *
 * Handled diff kinds:
 *   - `text`: insert / delete / mark add / mark remove inside a `LoroText`
 *   - `list`: block insert / delete / move on a parent's children list
 *   - `map`:  attribute updates on a block's `attributes` sub-map
 *
 * Other diff kinds (`tree`, `counter`) and any `event.by === "checkout"`
 * batch are routed to the fallback.
 */
export function loroEventBatchToTransaction(
  state: EditorState,
  batch: LoroEventBatch,
  mapping: LoroNodeMapping,
  doc: LoroDocType,
): Transaction | null {
  // Checkout events can carry diffs that essentially rewrite the document
  // (e.g. timeline scrubbing in a history viewer). Until we benchmark
  // them, route all checkouts through the safety-net rebuild. This check
  // is placed before the empty-batch shortcut so a synthetic batch with
  // by:"checkout" can't slip through.
  if (batch.by === "checkout") {
    return null;
  }
  if (batch.events.length === 0) {
    return state.tr;
  }

  const tr = state.tr;
  // Containers materialised into PM by a list-insert in this batch.
  // Subsequent events targeting any of them — or their descendants — are
  // skipped because the materialised PM subtree already reflects Loro's
  // post-batch state.
  const materialisedInBatch = new Set<ContainerID>();
  // Parent block ContainerIDs whose children list was mutated by some
  // earlier event in the batch (insert or delete). We use this to guard
  // findEmptyTextPosition, which only computes a correct offset when
  // the parent's children list has not been touched in this batch.
  const parentTouchedInBatch = new Set<ContainerID>();

  for (const event of batch.events) {
    if (materialisedInBatch.has(event.target)) {
      continue;
    }
    const ok = applyEvent(
      tr,
      state,
      event,
      mapping,
      doc,
      materialisedInBatch,
      parentTouchedInBatch,
    );
    if (!ok) {
      return null;
    }
  }
  return tr;
}

function applyEvent(
  tr: Transaction,
  state: EditorState,
  event: LoroEvent,
  mapping: LoroNodeMapping,
  doc: LoroDocType,
  materialisedInBatch: Set<ContainerID>,
  parentTouchedInBatch: Set<ContainerID>,
): boolean {
  switch (event.diff.type) {
    case "text":
      return applyTextDiff(
        tr,
        state,
        event.target,
        event.diff,
        mapping,
        doc,
        parentTouchedInBatch,
      );
    case "list":
      return applyListDiff(
        tr,
        state,
        event.target,
        event.diff,
        mapping,
        doc,
        materialisedInBatch,
        parentTouchedInBatch,
      );
    case "map":
      return applyMapDiff(tr, state, event.target, event.diff, mapping, doc);
    default:
      // tree / counter — not used by this binding.
      return false;
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function applyTextDiff(
  tr: Transaction,
  state: EditorState,
  target: ContainerID,
  diff: TextDiff,
  mapping: LoroNodeMapping,
  doc: LoroDocType,
  parentTouchedInBatch: Set<ContainerID>,
): boolean {
  const loc = findContainerLocation(state.doc, target, mapping);
  let prePos: number;
  let usedFallback = false;
  if (loc != null && loc.isText) {
    prePos = loc.pos;
  } else if (loc == null) {
    // Mapping miss: typical when the LoroText was emptied earlier in this
    // session and `updateLoroToPmState` pruned the entry. Walk to the
    // parent block to recover the insertion point — but only when no
    // sibling was added/removed in THIS batch (see
    // findEmptyTextPosition's docs for why).
    const text = doc.getContainerById(target);
    if (!(text instanceof LoroText)) {
      return false;
    }
    const parentList = text.parent();
    const parentBlock = parentList?.parent();
    if (
      parentBlock instanceof LoroMap &&
      parentTouchedInBatch.has(parentBlock.id)
    ) {
      return false;
    }
    const fallback = findEmptyTextPosition(state.doc, target, mapping, doc);
    if (fallback == null) {
      return false;
    }
    prePos = fallback;
    usedFallback = true;
  } else {
    // Container was found but isn't a text run — schema mismatch.
    return false;
  }

  let cursor = tr.mapping.map(prePos);
  for (const op of diff.diff as Delta<string>[]) {
    if (op.retain != null) {
      // Pre-batch text was empty (otherwise the mapping wouldn't have
      // been pruned), so `retain`/`delete` make no sense in the
      // fallback path. Bail rather than risk corruption.
      if (usedFallback) {
        return false;
      }
      if (op.attributes) {
        if (
          !applyMarkAttributes(
            tr,
            state.schema,
            cursor,
            cursor + op.retain,
            op.attributes,
          )
        ) {
          return false;
        }
      }
      cursor += op.retain;
    } else if (op.insert != null) {
      const marks = op.attributes
        ? attributesToMarks(state.schema, op.attributes)
        : [];
      if (marks === null) {
        return false;
      }
      const textNode = state.schema.text(op.insert, marks);
      tr.insert(cursor, textNode);
      cursor += op.insert.length;
    } else if (op.delete != null) {
      if (usedFallback) {
        return false;
      }
      tr.delete(cursor, cursor + op.delete);
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Convert a Loro text-attribute map to PM marks. Used when a delta op's
 * `insert` carries inline marks. Returns `null` if the schema does not
 * contain a referenced mark (caller bails to fallback).
 */
function attributesToMarks(
  schema: Schema,
  attributes: Record<string, Value | undefined>,
): Mark[] | null {
  const marks: Mark[] = [];
  for (const [name, raw] of Object.entries(attributes)) {
    if (raw == null) {
      continue;
    }
    const markType = schema.marks[name];
    if (markType == null) {
      return null;
    }
    const attrs = valueToAttrs(raw);
    marks.push(markType.create(attrs ?? undefined));
  }
  return marks;
}

/**
 * Apply a mark-attribute change over `[from, to)`.
 */
function applyMarkAttributes(
  tr: Transaction,
  schema: Schema,
  from: number,
  to: number,
  attributes: Record<string, Value | undefined>,
): boolean {
  for (const [name, raw] of Object.entries(attributes)) {
    const markType = schema.marks[name];
    if (markType == null) {
      return false;
    }
    if (raw == null) {
      tr.removeMark(from, to, markType);
    } else {
      const attrs = valueToAttrs(raw);
      tr.addMark(from, to, markType.create(attrs ?? undefined));
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// List (block-level edits on a parent's children list)
// ---------------------------------------------------------------------------

interface ListItemSnapshot {
  /**
   * The pre-state PM Node (or array of inline text nodes) for this child.
   * Captured so deletes can prune the mapping for the entire deleted
   * subtree.
   */
  pmNode: Node | Node[];
  /** PM offset of the start of this child relative to the parent's content. */
  pmStart: number;
  /** PM offset just past this child's content. */
  pmEnd: number;
}

function applyListDiff(
  tr: Transaction,
  state: EditorState,
  target: ContainerID,
  diff: { type: "list"; diff: Delta<(Value | Container)[]>[] },
  mapping: LoroNodeMapping,
  doc: LoroDocType,
  materialisedInBatch: Set<ContainerID>,
  parentTouchedInBatch: Set<ContainerID>,
): boolean {
  const loroList = doc.getContainerById(target);
  if (!(loroList instanceof LoroList)) {
    return false;
  }
  const parentMap = loroList.parent();
  if (!(parentMap instanceof LoroMap)) {
    return false;
  }
  if (parentMap.get(NODE_NAME_KEY) == null) {
    return false;
  }

  const parentLoc = findContainerLocation(state.doc, parentMap.id, mapping);
  if (parentLoc == null || parentLoc.isText) {
    return false;
  }
  const parentNode = parentLoc.node as Node;
  const parentPos = tr.mapping.map(parentLoc.pos);
  const isRootDoc = parentNode === state.doc;
  const contentStart = isRootDoc ? parentPos : parentPos + 1;

  const items = snapshotChildren(parentNode);

  let listIdx = 0;
  let pmCursor = 0;
  let listChanged = false;

  for (const op of diff.diff) {
    if (op.retain != null) {
      for (let i = 0; i < op.retain; i++) {
        if (listIdx >= items.length) {
          return false;
        }
        pmCursor += items[listIdx].pmEnd - items[listIdx].pmStart;
        listIdx++;
      }
    } else if (op.delete != null) {
      let removedSize = 0;
      const subtreesToPrune: (Node | Node[])[] = [];
      for (let i = 0; i < op.delete; i++) {
        if (listIdx >= items.length) {
          return false;
        }
        const item = items[listIdx];
        removedSize += item.pmEnd - item.pmStart;
        subtreesToPrune.push(item.pmNode);
        listIdx++;
      }
      if (removedSize > 0) {
        tr.delete(
          contentStart + pmCursor,
          contentStart + pmCursor + removedSize,
        );
        for (const subtree of subtreesToPrune) {
          pruneSubtreeFromMapping(subtree, mapping);
        }
        listChanged = true;
      }
    } else if (op.insert != null) {
      const inserted = op.insert as (Value | Container)[];

      // Build the fragment in a *scratch* mapping copy so we don't pollute
      // `mapping` if validation fails. createNodeFromLoroObj uses `get` for
      // memoisation and `set` for new bindings, so the scratch needs to
      // contain every existing entry.
      const scratchMapping: LoroNodeMapping = new Map(mapping);
      const fragments: Node[] = [];
      const newlyMaterialised: Container[] = [];
      for (const value of inserted) {
        if (!isContainer(value)) {
          return false;
        }
        const node = materializeInsertedContainer(
          state.schema,
          value,
          scratchMapping,
        );
        if (node == null) {
          return false;
        }
        newlyMaterialised.push(value);
        if (Array.isArray(node)) {
          for (const n of node) fragments.push(n);
        } else {
          fragments.push(node);
        }
      }
      const fragment = Fragment.from(fragments);

      // Validate that the fragment can fit at the target position. If
      // PM would have to "open"/lift content for the insertion to be
      // valid, we'd diverge from Loro silently — better to bail to the
      // safety-net rebuild.
      const insertPos = contentStart + pmCursor;
      let $pos;
      try {
        $pos = tr.doc.resolve(insertPos);
      } catch {
        return false;
      }
      if (!$pos.parent.canReplace($pos.index(), $pos.index(), fragment)) {
        return false;
      }

      // Commit: insert the fragment and merge the scratch mapping back.
      tr.insert(insertPos, fragment);
      for (const [k, v] of scratchMapping) {
        mapping.set(k, v);
      }
      for (const container of newlyMaterialised) {
        collectContainerIds(container, materialisedInBatch);
      }
      pmCursor += fragment.size;
      listChanged = true;
    } else {
      return false;
    }
  }

  if (listChanged) {
    parentTouchedInBatch.add(parentMap.id);
  }
  return true;
}

/**
 * Walk a parent block's pre-state PM children and turn them into a flat
 * array aligned 1:1 with the Loro children list. Consecutive PM text
 * nodes that share a single `LoroText` are coalesced into one entry.
 */
function snapshotChildren(parent: Node): ListItemSnapshot[] {
  const items: ListItemSnapshot[] = [];
  let offset = 0;
  let i = 0;
  while (i < parent.childCount) {
    const child = parent.child(i);
    if (child.isText) {
      const runStart = offset;
      const run: Node[] = [];
      while (i < parent.childCount && parent.child(i).isText) {
        run.push(parent.child(i));
        offset += parent.child(i).nodeSize;
        i++;
      }
      items.push({ pmNode: run, pmStart: runStart, pmEnd: offset });
    } else {
      items.push({
        pmNode: child,
        pmStart: offset,
        pmEnd: offset + child.nodeSize,
      });
      offset += child.nodeSize;
      i++;
    }
  }
  return items;
}

/**
 * Recursively remove `mapping` entries for every Loro container bound to
 * a deleted PM subtree.
 *
 * For block PM Nodes we look up the ContainerID in the
 * `WEAK_NODE_TO_LORO_CONTAINER_MAPPING` reverse index and prune by id
 * (and recurse into block children). For text runs we scan `mapping`
 * for the entry whose value is the array of text nodes — O(n) per run
 * but only triggered on delete.
 */
function pruneSubtreeFromMapping(
  pmNode: Node | Node[],
  mapping: LoroNodeMapping,
): void {
  if (Array.isArray(pmNode)) {
    if (pmNode.length === 0) {
      return;
    }
    const cid = findContainerIdForTextRun(mapping, pmNode);
    if (cid != null) {
      mapping.delete(cid);
    }
    return;
  }
  // Look up the ContainerID for this block via the reverse WeakMap first,
  // then fall back to a scan of `mapping` itself. The fallback matters
  // for two cases: (a) a Node that travelled through `node.toJSON()` /
  // `nodeFromJSON` round-trip (it loses its WeakMap binding), and
  // (b) a freshly-inserted block whose Node was just dropped into the
  // tree by `tr.insert` rather than by `createNodeFromLoroObj`.
  const cid =
    WEAK_NODE_TO_LORO_CONTAINER_MAPPING.get(pmNode) ??
    findBlockContainerId(mapping, pmNode);
  if (cid != null) {
    mapping.delete(cid);
  }
  let i = 0;
  while (i < pmNode.childCount) {
    const child = pmNode.child(i);
    if (child.isText) {
      const run: Node[] = [];
      while (i < pmNode.childCount && pmNode.child(i).isText) {
        run.push(pmNode.child(i));
        i++;
      }
      pruneSubtreeFromMapping(run, mapping);
    } else {
      pruneSubtreeFromMapping(child, mapping);
      i++;
    }
  }
}

function findContainerIdForTextRun(
  mapping: LoroNodeMapping,
  run: Node[],
): ContainerID | null {
  const first = run[0];
  for (const [id, value] of mapping) {
    if (Array.isArray(value) && value.includes(first)) {
      return id;
    }
  }
  return null;
}

function findBlockContainerId(
  mapping: LoroNodeMapping,
  block: Node,
): ContainerID | null {
  for (const [id, value] of mapping) {
    if (value === block) {
      return id;
    }
  }
  return null;
}

/**
 * Recursively collect every container ID inside a freshly-inserted
 * subtree, so that later events targeting any of them in the same batch
 * are skipped.
 */
function collectContainerIds(
  container: Container,
  set: Set<ContainerID>,
): void {
  set.add(container.id);
  if (container instanceof LoroMap) {
    for (const key of container.keys()) {
      const value = container.get(key);
      if (isContainer(value)) {
        collectContainerIds(value, set);
      }
    }
  } else if (container instanceof LoroList) {
    for (let i = 0; i < container.length; i++) {
      const value = container.get(i);
      if (isContainer(value)) {
        collectContainerIds(value, set);
      }
    }
  }
}

/**
 * Materialise a container that was just inserted into Loro into a PM
 * Node (or array of inline text nodes for `LoroText`), populating the
 * mapping with fresh bindings for it and any nested containers.
 *
 * Returns `null` for container types this binding does not support
 * (e.g. `LoroTree`); the caller bails to fallback.
 */
function materializeInsertedContainer(
  schema: Schema,
  container: Container,
  mapping: LoroNodeMapping,
): Node | Node[] | null {
  if (container instanceof LoroMap) {
    return createNodeFromLoroObj(
      schema,
      container as LoroMap<LoroNodeContainerType>,
      mapping,
    );
  }
  if (container instanceof LoroText) {
    return createNodeFromLoroObj(schema, container, mapping);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Map (attribute updates on a block's `attributes` sub-map)
// ---------------------------------------------------------------------------

function applyMapDiff(
  tr: Transaction,
  state: EditorState,
  target: ContainerID,
  diff: MapDiff,
  mapping: LoroNodeMapping,
  doc: LoroDocType,
): boolean {
  const container = doc.getContainerById(target);
  if (!(container instanceof LoroMap)) {
    return false;
  }
  const parent = container.parent();
  if (!(parent instanceof LoroMap)) {
    return false;
  }
  // Only handle map diffs on a block's `attributes` sub-map. A diff on
  // the block itself (e.g. nodeName change) or on an unrelated top-level
  // map falls back to the safety net.
  if (parent.get(NODE_NAME_KEY) == null) {
    return false;
  }
  const attrsContainer = parent.get(ATTRIBUTES_KEY);
  if (!(attrsContainer instanceof LoroMap) || attrsContainer.id !== target) {
    return false;
  }

  const blockLoc = findContainerLocation(state.doc, parent.id, mapping);
  if (blockLoc == null || blockLoc.isText || Array.isArray(blockLoc.node)) {
    return false;
  }
  const blockNode = blockLoc.node;
  const blockPos = tr.mapping.map(blockLoc.pos);

  const newAttrs: { [key: string]: unknown } = { ...blockNode.attrs };
  for (const [key, raw] of Object.entries(diff.updated)) {
    if (raw === undefined || raw === null) {
      delete newAttrs[key];
    } else if (isContainer(raw)) {
      return false;
    } else {
      newAttrs[key] = raw;
    }
  }

  try {
    tr.setNodeMarkup(blockPos, undefined, newAttrs);
  } catch {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function valueToAttrs(value: Value): { [key: string]: unknown } | null {
  if (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  ) {
    return value as { [key: string]: unknown };
  }
  return null;
}
