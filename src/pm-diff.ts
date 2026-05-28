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
  // Check if diff is empty (no changes) — children is iterable, not necessarily an array
  let hasChanges = false;
  for (const op of (diff as any).children) {
    if (!delta.$retainOp.check(op)) { hasChanges = true; break; }
  }
  if (!hasChanges) return null;
  return deltaToPSteps(tr, diff);
}
