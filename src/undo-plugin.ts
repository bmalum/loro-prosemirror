import type { Cursor } from "loro-crdt";
import { UndoManager } from "loro-crdt";
import {
  type Command,
  EditorState,
  Plugin,
  type StateField,
} from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { convertPmSelectionToCursors } from "./cursor/common";
import { syncCursorsToPmSelection } from "./sync-plugin";
import { loroSyncPluginKey } from "./sync-plugin-key";
import { configLoroTextStyle } from "./text-style";
import {
  loroUndoPluginKey,
  type LoroUndoPluginProps,
  type LoroUndoPluginState,
} from "./undo-plugin-key";

type Cursors = { anchor: Cursor | null; focus: Cursor | null };

export const LoroUndoPlugin = (props: LoroUndoPluginProps): Plugin => {
  const undoManager = props.undoManager || new UndoManager(props.doc, {});
  undoManager.addExcludeOriginPrefix("sys:init");

  // Closure mirror of the latest `prevSelection` computed by `apply()`.
  // The Loro `setOnPush` callback fires synchronously inside the apply
  // chain (Loro events fire while updateLoroToPmState writes), at which
  // point `view.state` has not yet been updated to include the new
  // plugin state — so reading via `loroUndoPluginKey.getState(view.state)`
  // would return the previous tick's value. Mirroring through this
  // closure variable from inside apply gives `setOnPush` access to the
  // in-flight value. See y-prosemirror's `latestPrevSel` for the same
  // pattern.
  let latestPrevSelection: Cursors = { anchor: null, focus: null };

  return new Plugin({
    key: loroUndoPluginKey,
    state: {
      init: (_config, editorState): LoroUndoPluginState => {
        configLoroTextStyle(props.doc, editorState.schema);
        return {
          undoManager,
          canUndo: undoManager.canUndo(),
          canRedo: undoManager.canRedo(),
          isUndoing: { current: false },
          prevSelection: null,
        };
      },
      apply: (
        tr,
        state,
        oldEditorState,
        _newEditorState,
      ): LoroUndoPluginState => {
        const loroState = loroSyncPluginKey.getState(oldEditorState);
        const isInternal =
          tr.getMeta(loroSyncPluginKey) != null ||
          tr.getMeta(loroUndoPluginKey) != null;

        let prevSelection = state.prevSelection;
        if (loroState != null && !isInternal) {
          // Capture the selection BEFORE this user transaction was applied,
          // so the next undo group can use it as the "where the cursor was
          // before the edit" anchor.
          const { anchor, focus } = convertPmSelectionToCursors(
            oldEditorState.doc,
            oldEditorState.selection,
            loroState,
          );
          prevSelection = { anchor: anchor ?? null, focus: focus ?? null };
        }
        latestPrevSelection = prevSelection ?? { anchor: null, focus: null };

        const canUndo = state.undoManager.canUndo();
        const canRedo = state.undoManager.canRedo();
        if (
          canUndo === state.canUndo &&
          canRedo === state.canRedo &&
          prevSelection === state.prevSelection
        ) {
          return state;
        }
        return { ...state, canUndo, canRedo, prevSelection };
      },
    } as StateField<LoroUndoPluginState>,

    view: (view: EditorView) => {
      undoManager.setOnPush((isUndo, _counterRange) => {
        const loroState = loroSyncPluginKey.getState(view.state);
        if (loroState?.doc == null) {
          return { value: null, cursors: [] };
        }

        const cursors: Cursor[] = [];
        let selection: Cursors = latestPrevSelection;
        if (!isUndo) {
          // For redo, use the current PM selection (the post-undo cursor).
          const { anchor, focus } = convertPmSelectionToCursors(
            view.state.doc,
            view.state.selection,
            loroState,
          );
          selection = { anchor: anchor ?? null, focus: focus ?? null };
        }

        if (selection.anchor) {
          cursors.push(selection.anchor);
        }
        if (selection.focus) {
          cursors.push(selection.focus);
        }

        return { value: null, cursors };
      });
      undoManager.setOnPop((_isUndo, meta, _counterRange) => {
        const loroState = loroSyncPluginKey.getState(view.state);
        if (loroState?.doc == null) {
          return;
        }

        const anchor: Cursor | undefined = meta.cursors[0];
        const focus: Cursor | undefined = meta.cursors[1];
        if (anchor == null) {
          return;
        }
        // Defer with queueMicrotask so the selection restore runs after
        // the non-local-updates transaction (which applied the undo'd
        // diff back into PM) has been committed to view.state. This is
        // a microtask not a macro-task, so any synchronous follow-up
        // still observes the correct cursor.
        queueMicrotask(() => {
          if (view.isDestroyed) {
            return;
          }
          syncCursorsToPmSelection(view, anchor, focus);
        });
      });
      return {
        destroy: () => {
          undoManager.setOnPop();
          undoManager.setOnPush();
        },
      };
    },
  });
};

export function canUndo(state: EditorState): boolean {
  const undoState = loroUndoPluginKey.getState(state);
  return undoState?.undoManager.canUndo() || false;
}

export function canRedo(state: EditorState): boolean {
  const undoState = loroUndoPluginKey.getState(state);
  return undoState?.undoManager.canRedo() || false;
}

export const undo: Command = (state, dispatch): boolean => {
  const undoState = loroUndoPluginKey.getState(state);
  if (!undoState) {
    return false;
  }

  if (!dispatch) {
    return undoState.undoManager.canUndo();
  }

  // Set/clear the re-entrancy flag synchronously around the call.
  // `undoManager.undo()` synchronously fires Loro events; the plugin's
  // event handler dispatches a PM transaction whose appendTransaction
  // is gated on the loroSyncPluginKey meta — so the echo loop is
  // already prevented. The flag remains as belt-and-braces for any
  // host that wraps this in a custom command pipeline.
  undoState.isUndoing.current = true;
  try {
    return undoState.undoManager.undo();
  } finally {
    undoState.isUndoing.current = false;
  }
};

export const redo: Command = (state, dispatch): boolean => {
  const undoState = loroUndoPluginKey.getState(state);
  if (!undoState) {
    return false;
  }

  if (!dispatch) {
    return undoState.undoManager.canRedo();
  }

  undoState.isUndoing.current = true;
  try {
    return undoState.undoManager.redo();
  } finally {
    undoState.isUndoing.current = false;
  }
};
