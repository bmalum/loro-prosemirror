import type { Cursor, UndoManager as LoroUndoManager } from "loro-crdt";
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
import { defaultLogger } from "./logger";

type Cursors = { anchor: Cursor | null; focus: Cursor | null };

/**
 * Tracks `UndoManager`s that already have an active `LoroUndoPlugin`
 * binding. Loro's `setOnPush` / `setOnPop` are single-slot — a second
 * mount would silently steal the callbacks from the first. We detect
 * the conflict here and warn loudly so consumers know to use one
 * UndoManager per editor.
 */
const BOUND_UNDO_MANAGERS = new WeakSet<LoroUndoManager>();

/**
 * Walk the EditorState's plugin list and return the key of the first
 * plugin that looks like a `prosemirror-history`-style undo manager,
 * or `null` if no such plugin is present.
 *
 * Detection is by plugin-key prefix: PM's `PluginKey("history")`
 * produces keys of the form `history$`, `history$1`, etc. (see
 * `prosemirror-state`'s `createKey`). This catches the canonical
 * `prosemirror-history` plugin and Tiptap's `History` extension
 * (which is a thin wrapper around prosemirror-history).
 *
 * False positives: any third-party plugin that happens to use the
 * name "history" in its `PluginKey`. Acceptable trade-off — the
 * warning is non-fatal, and naming conflicts with "history" are
 * rare in practice.
 */
function detectCompetingHistoryPlugin(
  state: import("prosemirror-state").EditorState,
): string | null {
  for (const plugin of state.plugins) {
    const pluginKey = (plugin as unknown as { key?: string }).key;
    if (typeof pluginKey === "string" && pluginKey.startsWith("history$")) {
      return pluginKey;
    }
  }
  return null;
}

export const LoroUndoPlugin = (props: LoroUndoPluginProps): Plugin => {
  const undoManager = props.undoManager || new UndoManager(props.doc, {});
  undoManager.addExcludeOriginPrefix("sys:init");
  const logger = props.logger ?? defaultLogger;

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
        // Selection-only transactions (no docChanged) MUST NOT update
        // prevSelection. If they did, an undo immediately following a
        // mouse-click selection move would land at the click position
        // rather than at the cursor's location before the last edit
        // — which is what the user actually wants undone.
        const isHistoryTracked = tr.getMeta("addToHistory") !== false;
        const shouldCapture =
          !isInternal && tr.docChanged && isHistoryTracked && loroState != null;

        let prevSelection = state.prevSelection;
        if (shouldCapture) {
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
        // Mirror only when we actually committed a new prevSelection.
        // PM contract: apply must be pure — but factory-scoped
        // `latestPrevSelection` IS observable side-effect. Restricting
        // updates to history-tracked, doc-changing user transactions
        // avoids polluting the mirror from speculative `state.apply`
        // calls (e.g. Tiptap's `chain()` which runs apply against
        // non-dispatched transactions).
        if (shouldCapture) {
          latestPrevSelection = prevSelection ?? { anchor: null, focus: null };
        }

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
      // Detect double-mount of the same UndoManager. Loro's
      // setOnPush/setOnPop are single-slot, so the second mount would
      // silently break the first. We detect once and warn — but we
      // still install our handlers (the user may have explicitly
      // unmounted the first plugin and is replacing the binding).
      if (BOUND_UNDO_MANAGERS.has(undoManager)) {
        logger.warn(
          "LoroUndoPlugin: this UndoManager is already bound to another editor. " +
            "Loro's setOnPush/setOnPop are single-slot, so the previous binding's " +
            "cursor capture and selection restore will stop working. " +
            "Use a separate UndoManager per editor.",
        );
      }
      BOUND_UNDO_MANAGERS.add(undoManager);

      // Warn loudly if a competing PM history plugin is also mounted.
      // Tiptap's StarterKit and many other host editors include
      // `prosemirror-history` by default. Both plugins intercept
      // Mod-Z independently and produce desynchronized state:
      //   - PM history reverses local steps; the resulting tx flows
      //     through the loroSyncPlugin and is recorded as a NEW Loro
      //     commit (not a Loro UndoManager pop).
      //   - Loro UndoManager records all PM-history-driven txs as
      //     separate commits. Calling our `undo` then pops the wrong
      //     entry and PM's history is out of sync with the doc.
      //
      // The fix is host-side: either disable the PM history plugin
      // (e.g. `StarterKit.configure({ history: false })`) OR avoid
      // calling our `undo`/`redo` and rely on PM history alone.
      const competingHistoryName = detectCompetingHistoryPlugin(view.state);
      if (competingHistoryName != null) {
        logger.warn(
          `LoroUndoPlugin: a competing PM history plugin ("${competingHistoryName}") ` +
            `is mounted in the same EditorState. Both will intercept undo independently; ` +
            `calling LoroUndoPlugin's \`undo\`/\`redo\` while the other plugin is also active ` +
            `causes desynchronization between PM history and the Loro op log. ` +
            `Either disable the competing history plugin (e.g. ` +
            `StarterKit.configure({ history: false })) or do not call LoroUndoPlugin's commands.`,
        );
      }

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
          BOUND_UNDO_MANAGERS.delete(undoManager);
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
