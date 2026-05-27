import {
  type Container,
  type ContainerID,
  type Delta,
  isContainer,
  LoroList,
  LoroMap,
  type LoroEvent,
  type LoroEventBatch,
  type MapDiff,
  type TextDiff,
  type Value,
} from "loro-crdt";
import { Fragment, type Mark, type Node, type Schema } from "prosemirror-model";
import { type EditorState, type Transaction } from "prosemirror-state";

import {
  ATTRIBUTES_KEY,
  CHILDREN_KEY,
  createNodeFromLoroObj,
  type LoroDocType,
  type LoroNode,
  type LoroNodeContainerType,
  type LoroNodeMapping,
  NODE_NAME_KEY,
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
 * has not been re-walked. Callers should treat `null` as "cannot translate
 * incrementally" and fall back to a full document rebuild.
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
 * Translate a `LoroEventBatch` into a ProseMirror `Transaction`.
 *
 * Returns `null` when any event cannot be translated; the caller MUST fall
 * back to a full document replace in that case so the doc never diverges
 * from Loro.
 *
 * Implements `text` (Phase 2), `list` (block insert/delete/move) and `map`
 * (attribute updates) diffs (Phase 3).
 */
export function loroEventBatchToTransaction(
  state: EditorState,
  batch: LoroEventBatch,
  mapping: LoroNodeMapping,
  doc: LoroDocType,
): Transaction | null {
  if (batch.events.length === 0) {
    return state.tr;
  }

  const tr = state.tr;
  // Containers that are materialised into PM as part of a list-insert in
  // this batch. Subsequent events that target any of them (or their
  // descendants) are skipped because the materialised PM subtree already
  // reflects the post-batch Loro state.
  const materialisedInBatch = new Set<ContainerID>();
  for (const event of batch.events) {
    if (materialisedInBatch.has(event.target)) {
      continue;
    }
    const ok = applyEvent(tr, state, event, mapping, doc, materialisedInBatch);
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
): boolean {
  switch (event.diff.type) {
    case "text":
      return applyTextDiff(tr, state, event.target, event.diff, mapping);
    case "list":
      return applyListDiff(
        tr,
        state,
        event.target,
        event.diff,
        mapping,
        doc,
        materialisedInBatch,
      );
    case "map":
      return applyMapDiff(tr, state, event.target, event.diff, mapping, doc);
    default:
      // tree / counter — not supported by this binding. Fall back.
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
): boolean {
  const loc = findContainerLocation(state.doc, target, mapping);
  if (loc == null || !loc.isText) {
    return false;
  }

  let cursor = tr.mapping.map(loc.pos);

  for (const op of diff.diff as Delta<string>[]) {
    if (op.retain != null) {
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
      tr.delete(cursor, cursor + op.delete);
    } else {
      return false;
    }
  }
  return true;
}

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
  /** ContainerID of this Loro child (or null when the child is a primitive). */
  containerId: ContainerID | null;
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
): boolean {
  const loroList = doc.getContainerById(target);
  if (!(loroList instanceof LoroList)) {
    return false;
  }
  const parentMap = loroList.parent();
  if (!(parentMap instanceof LoroMap)) {
    return false;
  }
  // Only translate edits on a block's children list — never on `data` etc.
  if (parentMap.get(NODE_NAME_KEY) == null) {
    return false;
  }

  const parentLoc = findContainerLocation(state.doc, parentMap.id, mapping);
  if (parentLoc == null || parentLoc.isText) {
    return false;
  }
  const parentNode = parentLoc.node as Node;
  const parentPos = tr.mapping.map(parentLoc.pos);
  // The root doc has no opening token, so its content starts AT `parentPos`
  // (which is 0). Every other block's content starts at `parentPos + 1`,
  // just past its opening token.
  const isRootDoc = parentNode === state.doc;
  const contentStart = isRootDoc ? parentPos : parentPos + 1;

  // Snapshot the parent's pre-state children grouped per Loro child container.
  const items = snapshotChildren(parentNode, mapping);
  if (items == null) {
    return false;
  }

  let listIdx = 0;
  let pmCursor = 0; // offset within parent's content, post-applied-ops doc

  for (const op of diff.diff) {
    if (op.retain != null) {
      for (let i = 0; i < op.retain; i++) {
        if (listIdx >= items.length) {
          return false;
        }
        const item = items[listIdx];
        pmCursor += item.pmEnd - item.pmStart;
        listIdx++;
      }
    } else if (op.delete != null) {
      let removedSize = 0;
      for (let i = 0; i < op.delete; i++) {
        if (listIdx >= items.length) {
          return false;
        }
        const item = items[listIdx];
        removedSize += item.pmEnd - item.pmStart;
        listIdx++;
      }
      if (removedSize > 0) {
        tr.delete(
          contentStart + pmCursor,
          contentStart + pmCursor + removedSize,
        );
      }
    } else if (op.insert != null) {
      const inserted = op.insert as (Value | Container)[];
      const fragments: Node[] = [];
      for (const value of inserted) {
        if (!isContainer(value)) {
          // Block children must be containers in this binding.
          return false;
        }
        const node = materializeInsertedContainer(state.schema, value, mapping);
        if (node == null) {
          return false;
        }
        // Mark this container — and every nested container we just bound
        // into the mapping — as materialised in this batch, so that any
        // later event targeting it is skipped. The PM subtree already
        // reflects Loro's post-batch state.
        collectContainerIds(value, materialisedInBatch);
        if (Array.isArray(node)) {
          for (const n of node) fragments.push(n);
        } else {
          fragments.push(node);
        }
      }
      const fragment = Fragment.from(fragments);
      tr.insert(contentStart + pmCursor, fragment);
      pmCursor += fragment.size;
    } else {
      return false;
    }
  }
  return true;
}

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
 * Walk a parent block's pre-state PM children and group them by the Loro
 * container they map to. Consecutive PM text nodes that share a `LoroText`
 * container are coalesced into a single snapshot entry, so the resulting
 * list aligns 1:1 with the Loro `children` list.
 *
 * Returns `null` when a container can't be resolved — the caller bails to
 * the full-replace fallback.
 */
function snapshotChildren(
  parent: Node,
  mapping: LoroNodeMapping,
): ListItemSnapshot[] | null {
  const items: ListItemSnapshot[] = [];
  let offset = 0;
  let i = 0;
  while (i < parent.childCount) {
    const child = parent.child(i);
    if (child.isText) {
      // Group consecutive text nodes into the LoroText container that owns
      // the run.
      const runStart = offset;
      const runStartIdx = i;
      while (i < parent.childCount && parent.child(i).isText) {
        offset += parent.child(i).nodeSize;
        i++;
      }
      const containerId = findTextContainerId(
        mapping,
        parent.child(runStartIdx),
      );
      items.push({
        containerId,
        pmStart: runStart,
        pmEnd: offset,
      });
    } else {
      const containerId = findBlockContainerId(mapping, child);
      items.push({
        containerId,
        pmStart: offset,
        pmEnd: offset + child.nodeSize,
      });
      offset += child.nodeSize;
      i++;
    }
  }
  return items;
}

function findTextContainerId(
  mapping: LoroNodeMapping,
  textNode: Node,
): ContainerID | null {
  for (const [id, value] of mapping) {
    if (Array.isArray(value) && value.includes(textNode)) {
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
 * Materialise a container that has just been inserted into Loro into a PM
 * Node (or array of text nodes for `LoroText`), populating the mapping with
 * fresh bindings for it and any nested containers.
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
  // LoroText is the only other allowed inline container in this binding.
  // We rely on createNodeFromLoroObj's overload to handle it.
  return createNodeFromLoroObj(schema, container as never, mapping);
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
  // We only handle map diffs on a block's `attributes` sub-map. Anything
  // else (e.g. a nodeName change on the block itself, or an unrelated
  // top-level map) falls back to the safety net.
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
      // Container-valued attrs aren't representable in the PM schema we
      // target; bail to fallback.
      return false;
    } else {
      newAttrs[key] = raw;
    }
  }

  try {
    tr.setNodeMarkup(blockPos, undefined, newAttrs);
  } catch {
    // Schema rejected the new attrs — bail.
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
