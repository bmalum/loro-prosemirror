import type { Cursor, LoroDoc, UndoManager } from "loro-crdt";
import { PluginKey } from "prosemirror-state";
import type { LoroLogger } from "./logger";

export const loroUndoPluginKey = new PluginKey<LoroUndoPluginState>(
  "loro-undo",
);

export interface LoroUndoPluginProps {
  doc: LoroDoc;
  undoManager?: UndoManager;
  /**
   * Optional structured logger. When omitted, the plugin uses a
   * built-in console logger that prints `error` and `warn` only.
   */
  logger?: LoroLogger;
}

export interface LoroUndoPluginState {
  undoManager: UndoManager;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Re-entrancy guard set by `undo()` / `redo()` while
   * `UndoManager.undo()` / `.redo()` are in flight. The flag is read by
   * the sync plugin's `apply` for the `doc-changed` branch so the
   * plugin doesn't echo the undo's PM transaction back into Loro. The
   * `appendTransaction` skip-on-internal-meta guard already prevents
   * the echo for typical batches; this flag is the belt-and-braces for
   * stacking undo/redo with a custom command pipeline.
   */
  isUndoing: { current: boolean };
  /**
   * Selection captured BEFORE the last user transaction was applied.
   * Used by the `UndoManager.setOnPush` callback to remember where the
   * cursor was before the edit, so an `undo()` lands the cursor back
   * at that position. `null` until the first user transaction.
   */
  prevSelection: { anchor: Cursor | null; focus: Cursor | null } | null;
}
