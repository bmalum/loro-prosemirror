import type {
  ContainerID,
  Delta,
  LoroEvent,
  LoroEventBatch,
  TextDiff,
  Value,
} from "loro-crdt";
import { type Mark, type Node, type Schema } from "prosemirror-model";
import { type EditorState, type Transaction } from "prosemirror-state";

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
 *
 * The search is intentionally simple: a single `descendants` walk per
 * container. This is O(n) in the doc size, but in practice only a handful of
 * containers change per event batch and the cost is dwarfed by the cost of
 * the full rebuild it replaces.
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
    // live inside the same parent block; the run starts at the first one.
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
          // + offset accounts for siblings that precede the text run
          // (e.g. an inline image or hard-break before the text).
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
 * back to a full document replace in that case so the doc never diverges
 * from Loro.
 *
 * Currently implements:
 *   - `text` diffs (insert / delete / retain with mark attributes)
 *
 * Pending phases will add `list` (block insert/delete/move) and `map`
 * (attribute changes) translators.
 */
export function loroEventBatchToTransaction(
  state: EditorState,
  batch: LoroEventBatch,
  mapping: LoroNodeMapping,
): Transaction | null {
  if (batch.events.length === 0) {
    return state.tr;
  }

  const tr = state.tr;
  for (const event of batch.events) {
    const ok = applyEvent(tr, state, event, mapping);
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
): boolean {
  switch (event.diff.type) {
    case "text":
      return applyTextDiff(tr, state, event.target, event.diff, mapping);
    default:
      // list / map / tree / counter — not yet implemented. Caller falls back.
      return false;
  }
}

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

  // Translate the run-start position from the pre-batch doc into the
  // current (in-progress) tr.doc coordinate space.
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
      // cursor stays — the deleted region used to start at `cursor`.
    } else {
      // Unknown delta op shape.
      return false;
    }
  }
  return true;
}

/**
 * Convert a Loro text-attribute map to PM marks.
 *
 * Returns `null` when the schema does not contain a referenced mark — in
 * that case the caller bails out and the safety-net rebuild handles the
 * event.
 */
function attributesToMarks(
  schema: Schema,
  attributes: Record<string, Value | undefined>,
): Mark[] | null {
  const marks: Mark[] = [];
  for (const [name, raw] of Object.entries(attributes)) {
    if (raw == null) {
      // A null attribute on `insert` means "no mark", which is the default.
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
 *
 * For each entry `[name, value]`:
 *   - `value === null` removes all marks of that type from the range
 *   - any other value adds the mark with the given attrs (replacing any
 *     prior mark of the same type by PM's mark-dedup rules).
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
