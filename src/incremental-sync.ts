import type { ContainerID, LoroEvent, LoroEventBatch } from "loro-crdt";
import type { Node } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";

import { type LoroNodeMapping } from "./lib";

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
   * The absolute PM position of `node`. For a `LoroText` it is the position
   * of the start of the parent block's content (the offset just inside the
   * opening token of the parent), so that text-delta offsets compose cleanly
   * with `tr.replaceWith`/`tr.insertText` calls.
   */
  pos: number;
  /** `true` when the container is a `LoroText` (mapped to `Node[]`). */
  isText: boolean;
}

/**
 * Find the position of a Loro container inside the current PM doc.
 *
 * Returns `null` when the container has no PM mapping yet — for example when
 * a brand-new container has just arrived via a remote update and the parent
 * has not been re-walked. Callers should treat `null` as "cannot translate
 * incrementally" and fall back to a full document rebuild.
 *
 * The search is intentionally simple: a single `descendants` walk per
 * container. This is O(n) in the doc size, but in practice n is small (one
 * walk per changed container per batch) and the cost is dwarfed by the cost
 * of the full rebuild it replaces.
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
    // LoroText: the mapped value is the inline run of text nodes. They all
    // live inside the same parent block, so finding the parent gives us the
    // offset of the run's start.
    if (mapped.length === 0) {
      return null;
    }
    const firstText = mapped[0];
    let parentContentStart: number | null = null;
    doc.descendants((node, pos) => {
      if (parentContentStart != null) {
        return false;
      }
      for (let i = 0; i < node.childCount; i++) {
        if (node.child(i) === firstText) {
          // `pos` is the position of `node` itself; `pos + 1` is the start
          // of its content (just inside the opening token).
          parentContentStart = pos + 1;
          return false;
        }
      }
      return true;
    });
    if (parentContentStart == null) {
      return null;
    }
    return { node: mapped, pos: parentContentStart, isText: true };
  }

  // Non-text Node: search by reference identity.
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
 * back to a full document replace in that case so the doc never diverges.
 *
 * In Phase 1 this is a stub: it returns `null` for any non-empty batch and
 * the caller falls back to the existing rebuild path. Subsequent phases
 * implement text (Phase 2), list/map (Phase 3) and edge cases (Phase 4).
 */
export function loroEventBatchToTransaction(
  state: EditorState,
  batch: LoroEventBatch,
  mapping: LoroNodeMapping,
): Transaction | null {
  // Empty batches are a valid no-op; return an empty transaction so the
  // caller can dispatch and exit cleanly without invoking the fallback.
  if (batch.events.length === 0) {
    return state.tr;
  }

  let tr: Transaction | null = state.tr;
  for (const event of batch.events) {
    tr = applyEvent(tr, event, mapping);
    if (tr == null) {
      return null;
    }
  }
  return tr;
}

function applyEvent(
  _tr: Transaction,
  _event: LoroEvent,
  _mapping: LoroNodeMapping,
): Transaction | null {
  // Phase 1 placeholder. Phase 2 will implement text diffs; Phase 3 list and
  // map diffs; Phase 4 nested + concurrent edge cases.
  return null;
}
