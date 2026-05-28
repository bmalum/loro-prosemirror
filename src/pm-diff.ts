/**
 * pm-diff.ts — Minimal diff between two ProseMirror documents as real PM steps.
 *
 * Ported from y-prosemirror (src/sync-utils.js) by the Super Loop team.
 * Original: https://github.com/yjs/y-prosemirror
 *
 * Key functions:
 *   nodeToDelta(node)          — convert a PM node to a lib0 delta
 *   deltaToPSteps(tr, diff)    — apply a delta diff as real PM steps
 *   diffPmDocs(tr, old, new)   — compute diff and apply as PM steps
 *
 * Using real PM steps (ReplaceStep, AddMarkStep, etc.) means PM's native
 * selection mapping handles cursor preservation automatically — no cursor
 * guard or queueMicrotask needed.
 */

import * as delta from "lib0/delta";
import { Fragment, type Node, Slice } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import type { LoroList, LoroMap, LoroText } from "loro-crdt";
import { LoroList as LoroListClass, LoroMap as LoroMapClass, LoroText as LoroTextClass } from "loro-crdt";
import {
  ATTRIBUTES_KEY,
  CHILDREN_KEY,
  type LoroDocType,
  type LoroNodeContainerType,
  type LoroNodeMapping,
  ROOT_DOC_KEY,
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING,
} from "./lib";

// Helper: check container type via ID suffix (avoids instanceof issues with WASM classes)
const isLoroText = (c: unknown): c is LoroText =>
  typeof (c as any)?.id === "string" && (c as any).id.endsWith(":Text");
const isLoroMap = (c: unknown): c is LoroMap<any> =>
  typeof (c as any)?.id === "string" && (c as any).id.endsWith(":Map");

// ─── Delta schema ────────────────────────────────────────────────────────────

// We use a simple delta schema: text nodes are text ops, block nodes are
// insert ops containing a nested delta. Marks become format attributes.

const marksToFormat = (marks: readonly import("prosemirror-model").Mark[]): Record<string, unknown> | null => {
  if (marks.length === 0) return null;
  const fmt: Record<string, unknown> = {};
  marks.forEach(m => { fmt[m.type.name] = m.attrs; });
  return fmt;
};

const formatToMarks = (
  fmt: Record<string, unknown> | null,
  schema: import("prosemirror-model").Schema,
): import("prosemirror-model").Mark[] => {
  if (!fmt) return [];
  return Object.entries(fmt)
    .filter(([, v]) => v != null)
    .map(([k, v]) => schema.mark(k, v as Record<string, unknown>))
    .filter(Boolean);
};

/**
 * Convert a ProseMirror node to a lib0 delta.
 * Text nodes → text ops. Block nodes → insert ops with nested delta.
 */
export function nodeToDelta(node: Node): delta.DeltaAny {
  const d = delta.create(node.type.name);
  // Store node attrs
  Object.entries(node.attrs).forEach(([k, v]) => {
    if (v != null) (d as any).attrs[k] = v;
  });
  node.content.forEach(child => {
    if (child.isText) {
      d.insert(child.text ?? "", marksToFormat(child.marks));
    } else {
      d.insert([nodeToDelta(child)], marksToFormat(child.marks));
    }
  });
  return d.done(false);
}

/**
 * Apply a lib0 delta diff as real ProseMirror steps on the transaction.
 * Adapted from y-prosemirror's deltaToPSteps.
 */
export function deltaToPSteps(
  tr: Transaction,
  d: delta.DeltaAny,
  pnode: Node = tr.doc,
  currPos: { i: number } = { i: 0 },
): Transaction {
  const schema = tr.doc.type.schema;
  let currParentIndex = 0;
  let nOffset = 0;
  const pchildren = pnode.content.content;

  // Apply node-level attr changes
  for (const [k, v] of Object.entries((d as any).attrs ?? {})) {
    tr.setNodeAttribute(currPos.i - 1, k, v);
  }

  for (const op of (d as any).children) {
    if (delta.$retainOp.check(op)) {
      let i = op.retain;
      while (i > 0) {
        const pc = pchildren[currParentIndex];
        if (!pc) throw new Error("[pm-diff] retain out of bounds");
        if (pc.isText) {
          if (op.format != null) {
            const from = currPos.i;
            const to = currPos.i + Math.min(pc.nodeSize - nOffset, i);
            Object.entries(op.format).forEach(([k, v]) => {
              if (v == null) tr.removeMark(from, to, schema.marks[k]);
              else tr.addMark(from, to, schema.mark(k, v as Record<string, unknown>));
            });
          }
          if (i + nOffset < pc.nodeSize) {
            nOffset += i; currPos.i += i; i = 0;
          } else {
            currParentIndex++;
            i -= pc.nodeSize - nOffset;
            currPos.i += pc.nodeSize - nOffset;
            nOffset = 0;
          }
        } else {
          currParentIndex++;
          currPos.i += pc.nodeSize;
          i--;
        }
      }
    } else if (delta.$modifyOp.check(op)) {
      const child = pchildren[currParentIndex++];
      const childStart = currPos.i;
      const sizeBefore = tr.doc.content.size;
      currPos.i = childStart + 1;
      deltaToPSteps(tr, op.value, child, currPos);
      const netChange = tr.doc.content.size - sizeBefore;
      currPos.i = childStart + child.nodeSize + netChange;
    } else if (delta.$insertOp.check(op)) {
      const newNodes = (op.insert as delta.DeltaAny[]).map(ins =>
        deltaToPNode(ins, schema, op.format)
      );
      tr.replace(currPos.i, currPos.i, new Slice(Fragment.from(newNodes), 0, 0));
      currPos.i += newNodes.reduce((s, c) => c.nodeSize + s, 0);
    } else if (delta.$textOp.check(op)) {
      const marks = formatToMarks(op.format, schema);
      tr.replace(
        currPos.i, currPos.i,
        new Slice(Fragment.from(schema.text(op.insert as string, marks)), 0, 0),
      );
      currPos.i += (op.insert as string).length;
    } else if (delta.$deleteOp.check(op)) {
      let remaining = op.delete;
      while (remaining > 0) {
        const pc = pchildren[currParentIndex];
        if (!pc) throw new Error("[pm-diff] delete out of bounds");
        if (pc.isText) {
          const delLen = Math.min(pc.nodeSize - nOffset, remaining);
          tr.replace(currPos.i, currPos.i + delLen, Slice.empty);
          nOffset += delLen;
          if (nOffset === pc.nodeSize) { nOffset = 0; currParentIndex++; }
          remaining -= delLen;
        } else {
          tr.replace(currPos.i, currPos.i + pc.nodeSize, Slice.empty);
          currParentIndex++;
          remaining--;
        }
      }
    }
  }
  return tr;
}

function deltaToPNode(
  d: delta.DeltaAny,
  schema: import("prosemirror-model").Schema,
  dformat: Record<string, unknown> | null,
): Node {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((d as any).attrs ?? {})) {
    attrs[k] = v;
  }
  const children = Array.from((d as any).children ?? []).flatMap((op: any) => {
    if (delta.$insertOp.check(op)) {
      return (op.insert as delta.DeltaAny[]).map(c => deltaToPNode(c, schema, op.format));
    }
    if (delta.$textOp.check(op)) {
      return [schema.text(op.insert as string, formatToMarks(op.format, schema))];
    }
    return [];
  });
  const nodeType = schema.nodes[(d as any).name ?? "doc"];
  if (!nodeType) throw new Error(`[pm-diff] unknown node type: ${(d as any).name}`);
  const node = nodeType.createAndFill(attrs, children, formatToMarks(dformat, schema));
  if (!node) throw new Error(`[pm-diff] createAndFill failed for: ${(d as any).name}`);
  return node;
}

/**
 * Compute the minimal diff between two PM docs and apply it as real PM steps.
 * Uses the Loro-derived nodes (from createNodeFromLoroObj) for changed blocks,
 * which ensures WEAK_NODE_TO_LORO_CONTAINER_MAPPING entries are set correctly.
 *
 * Returns the transaction with the steps applied, or null if docs are identical.
 */
export function diffPmDocs(
  tr: Transaction,
  oldDoc: Node,
  newDoc: Node,
): Transaction | null {
  const oldDelta = nodeToDelta(oldDoc);
  const newDelta = nodeToDelta(newDoc);
  const diff = delta.diff(oldDelta, newDelta);
  // Check if diff is empty
  let hasChanges = false;
  for (const op of (diff as any).children) {
    if (!delta.$retainOp.check(op)) { hasChanges = true; break; }
  }
  if (!hasChanges) return null;

  // Apply the diff using the newDoc's actual nodes (from createNodeFromLoroObj)
  // rather than creating new nodes via deltaToPNode. This preserves the
  // WEAK_NODE_TO_LORO_CONTAINER_MAPPING entries set by createNodeFromLoroObj.
  return applyBlockDiff(tr, oldDoc, newDoc, diff);
}

/**
 * Apply a block-level diff using the actual nodes from newDoc.
 * For unchanged blocks: keep oldDoc nodes (PM step mapping handles cursor).
 * For changed/inserted blocks: use newDoc nodes (have correct mapping entries).
 */
function applyBlockDiff(
  tr: Transaction,
  oldDoc: Node,
  newDoc: Node,
  diff: delta.DeltaAny,
): Transaction {
  let oldIdx = 0;
  let newIdx = 0;
  let pos = 0; // current position in tr.doc

  for (const op of (diff as any).children) {
    if (delta.$retainOp.check(op)) {
      // Unchanged blocks — skip over them
      for (let i = 0; i < op.retain; i++) {
        pos += oldDoc.child(oldIdx).nodeSize;
        oldIdx++;
        newIdx++;
      }
    } else if (delta.$modifyOp.check(op)) {
      // Block content changed — replace with newDoc's version
      const oldBlock = oldDoc.child(oldIdx);
      const newBlock = newDoc.child(newIdx);
      tr.replace(pos, pos + oldBlock.nodeSize, new Slice(Fragment.from(newBlock), 0, 0));
      pos += newBlock.nodeSize;
      oldIdx++;
      newIdx++;
    } else if (delta.$insertOp.check(op)) {
      // New blocks inserted — use newDoc's nodes
      const insertedBlocks: Node[] = [];
      for (let i = 0; i < (op.insert as any[]).length; i++) {
        insertedBlocks.push(newDoc.child(newIdx++));
      }
      tr.replace(pos, pos, new Slice(Fragment.from(insertedBlocks), 0, 0));
      pos += insertedBlocks.reduce((s, b) => s + b.nodeSize, 0);
    } else if (delta.$deleteOp.check(op)) {
      // Blocks deleted
      let deleteSize = 0;
      for (let i = 0; i < op.delete; i++) {
        deleteSize += oldDoc.child(oldIdx++).nodeSize;
      }
      tr.replace(pos, pos + deleteSize, Slice.empty);
    }
  }
  return tr;
}

/**
 * After diffPmDocs, the new PM doc has nodes created by deltaToPNode which
 * don't have WEAK_NODE_TO_LORO_CONTAINER_MAPPING entries. This function walks
 * the Loro doc and the new PM doc in parallel to rebuild the mapping.
 *
 * The Loro doc and the new PM doc have the same structure (that's the point
 * of the diff), so we can walk them together and establish the correspondence.
 */
export function rebuildMappingAfterDiff(
  loroDoc: LoroDocType,
  pmDoc: Node,
  mapping: LoroNodeMapping,
  containerId?: import("loro-crdt").ContainerID,
): void {
  mapping.clear();
  const innerDoc = containerId
    ? (loroDoc.getContainerById(containerId) as LoroMap<LoroNodeContainerType>)
    : loroDoc.getMap(ROOT_DOC_KEY);
  if (!innerDoc) return;
  // Map root
  mapping.set(innerDoc.id, pmDoc);
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(pmDoc, innerDoc.id);
  // Walk children in parallel
  const loroChildren = innerDoc.get(CHILDREN_KEY) as LoroList | undefined;
  if (!loroChildren) return;
  walkLoroAndPm(loroChildren, pmDoc, mapping);
}

function walkLoroAndPm(
  loroList: LoroList,
  pmNode: Node,
  mapping: LoroNodeMapping,
): void {
  const pmChildren = pmNode.content.content;
  const loroLen = loroList.length;
  let pmIdx = 0;
  for (let i = 0; i < loroLen && pmIdx < pmChildren.length; i++) {
    const loroChild = loroList.get(i);
    if (!loroChild) continue;
    const cid = (loroChild as any)?.id ?? "unknown";
    if (isLoroText(loroChild)) {
      // LoroText → collect consecutive PM text nodes
      const textNodes: Node[] = [];
      while (pmIdx < pmChildren.length && pmChildren[pmIdx].isText) {
        textNodes.push(pmChildren[pmIdx++]);
      }
      if (textNodes.length > 0) {
        mapping.set(loroChild.id, textNodes);
        for (const tn of textNodes) {
          WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(tn, loroChild.id);
        }
      }
    } else if (isLoroMap(loroChild)) {
      const pmChild = pmChildren[pmIdx++];
      if (!pmChild) break;
      mapping.set(loroChild.id, pmChild);
      WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(pmChild, loroChild.id);
      console.debug("[walkLoroAndPm] set", { cid: loroChild.id, pmChildType: pmChild.type.name, weakMapSet: WEAK_NODE_TO_LORO_CONTAINER_MAPPING.get(pmChild) === loroChild.id });
      const childList = loroChild.get(CHILDREN_KEY) as LoroList | undefined;
      if (childList) walkLoroAndPm(childList, pmChild, mapping);
    }
  }
}
