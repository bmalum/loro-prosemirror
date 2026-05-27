import type { Cursor, LoroEventBatch, LoroMap } from "loro-crdt";
import { Fragment, Slice } from "prosemirror-model";
import { type EditorState, Plugin, type StateField } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import {
  convertPmSelectionToCursors,
  cursorToAbsolutePosition,
} from "./cursor/common";
import { loroEventBatchToTransaction } from "./incremental-sync";
import {
  clearChangedNodes,
  createNodeFromLoroObj,
  type LoroDocType,
  type LoroNodeContainerType,
  type LoroNodeMapping,
  ROOT_DOC_KEY,
  safeSetSelection,
  updateLoroToPmState,
} from "./lib";
import {
  loroSyncPluginKey,
  type LoroSyncEvent,
  type LoroSyncPluginProps,
  type LoroSyncPluginState,
} from "./sync-plugin-key";
import { configLoroTextStyle } from "./text-style";
import { loroUndoPluginKey } from "./undo-plugin-key";

type PluginTransactionType =
  | {
      type: "doc-changed";
    }
  | {
      type: "non-local-updates";
    }
  | {
      type: "update-state";
      state: Partial<LoroSyncPluginState>;
    };

export const LoroSyncPlugin = (props: LoroSyncPluginProps): Plugin => {
  return new Plugin({
    key: loroSyncPluginKey,
    props: {
      editable: (state) => {
        const syncState = loroSyncPluginKey.getState(state);
        return syncState?.snapshot == null;
      },
    },
    state: {
      init: (_config, editorState): LoroSyncPluginState => {
        configLoroTextStyle(props.doc, editorState.schema);

        return {
          doc: props.doc,
          mapping: props.mapping ?? new Map(),
          changedBy: "local",
          containerId: props.containerId,
          onSyncEvent: props.onSyncEvent,
        };
      },
      apply: (tr, state, oldEditorState, newEditorState) => {
        const meta = tr.getMeta(
          loroSyncPluginKey,
        ) as PluginTransactionType | null;
        const undoState = loroUndoPluginKey.getState(oldEditorState);

        if (meta?.type === "non-local-updates") {
          state.changedBy = "import";
        } else {
          state.changedBy = "local";
        }
        switch (meta?.type) {
          case "doc-changed":
            if (!undoState?.isUndoing.current) {
              updateLoroToPmState(
                state.doc as LoroDocType,
                state.mapping,
                newEditorState,
                props.containerId,
              );
            }
            break;
          case "update-state":
            state = { ...state, ...meta.state };
            state.doc.commit({
              origin: "sys:init",
              timestamp: Date.now(),
            });
            break;
          default:
            break;
        }
        return state;
      },
    } as StateField<LoroSyncPluginState>,
    appendTransaction: (transactions, _oldEditorState, newEditorState) => {
      if (transactions.some((tr) => tr.docChanged)) {
        return newEditorState.tr.setMeta(loroSyncPluginKey, {
          type: "doc-changed",
        });
      }
      return null;
    },
    view: (view: EditorView) => {
      const timeoutId = setTimeout(() => init(view), 0);
      return {
        update: (_view: EditorView, _prevState: EditorState) => {},
        destroy: () => {
          clearTimeout(timeoutId);
        },
      };
    },
  });
};

// This is called when the plugin's state is associated with an editor view
function init(view: EditorView) {
  if (view.isDestroyed) {
    return;
  }

  const state = loroSyncPluginKey.getState(view.state) as LoroSyncPluginState;

  let docSubscription = state.docSubscription;

  docSubscription?.();

  if (state.containerId) {
    docSubscription = state
      .doc!.getContainerById(state.containerId)!
      .subscribe((event) => {
        updateNodeOnLoroEvent(view, event);
      });
  } else {
    docSubscription = state.doc.subscribe((event) =>
      updateNodeOnLoroEvent(view, event),
    );
  }

  const innerDoc = state.containerId
    ? (state.doc.getContainerById(
        state.containerId,
      ) as LoroMap<LoroNodeContainerType>)
    : (state.doc as LoroDocType).getMap(ROOT_DOC_KEY);

  const mapping: LoroNodeMapping = new Map();
  if (innerDoc.size === 0) {
    // Empty doc
    const tr = view.state.tr.delete(0, view.state.doc.content.size);
    tr.setMeta(loroSyncPluginKey, {
      type: "update-state",
      state: { mapping, docSubscription, snapshot: null },
    });
    view.dispatch(tr);
  } else {
    const schema = view.state.schema;
    // Create node from loro object
    const node = createNodeFromLoroObj(
      schema,
      innerDoc as LoroMap<LoroNodeContainerType>,
      mapping,
    );
    const tr = view.state.tr.replace(
      0,
      view.state.doc.content.size,
      new Slice(Fragment.from(node), 0, 0),
    );
    tr.setMeta(loroSyncPluginKey, {
      type: "update-state",
      state: { mapping, docSubscription, snapshot: null },
    });
    view.dispatch(tr);
  }
}

function updateNodeOnLoroEvent(view: EditorView, event: LoroEventBatch) {
  if (view.isDestroyed) {
    return;
  }

  const state = loroSyncPluginKey.getState(view.state) as LoroSyncPluginState;
  state.changedBy = event.by;
  if (event.by === "local" && event.origin !== "undo") {
    return;
  }

  // First try to translate the event batch into surgical PM Steps. When the
  // translation succeeds we dispatch a single transaction and rely on PM's
  // built-in selection mapping to keep the cursor in place — no manual
  // `setTimeout(syncCursorsToPmSelection)` dance is needed.
  //
  // When the translator returns null (or throws) we fall back to the legacy
  // full-document rebuild so the doc never diverges. This is the safety net.
  const { tr: incrementalTr, threw } = tryIncrementalSync(view, event, state);
  if (incrementalTr != null) {
    incrementalTr.setMeta(loroSyncPluginKey, { type: "non-local-updates" });
    view.dispatch(incrementalTr);
    emitSyncEvent(state, {
      kind: "incremental",
      eventCount: event.events.length,
      by: event.by,
      origin: event.origin,
    });
    return;
  }

  emitSyncEvent(state, {
    kind: "fallback",
    reason: threw
      ? "translator-threw"
      : event.by === "checkout"
        ? "checkout"
        : "translator-null",
    eventCount: event.events.length,
    by: event.by,
    origin: event.origin,
  });
  fullReplaceFallback(view, event, state);
}

/**
 * Notify the consumer's `onSyncEvent` hook, if any. A throwing hook is
 * never allowed to break the dispatch flow.
 */
function emitSyncEvent(state: LoroSyncPluginState, info: LoroSyncEvent) {
  const hook = state.onSyncEvent;
  if (hook == null) {
    return;
  }
  try {
    hook(info);
  } catch (e) {
    console.error("[loro-prosemirror] onSyncEvent hook threw:", e);
  }
}

/**
 * Attempt to build an incremental ProseMirror transaction from a Loro event
 * batch. The boolean `threw` lets the caller distinguish a bail-because-
 * unsupported (`null`, `threw=false`) from a bail-because-error
 * (`null`, `threw=true`) so the metrics hook can report the reason.
 */
function tryIncrementalSync(
  view: EditorView,
  event: LoroEventBatch,
  state: LoroSyncPluginState,
): { tr: ReturnType<typeof loroEventBatchToTransaction>; threw: boolean } {
  try {
    const tr = loroEventBatchToTransaction(
      view.state,
      event,
      state.mapping,
      state.doc as LoroDocType,
    );
    return { tr, threw: false };
  } catch (e) {
    console.error(
      "[loro-prosemirror] incremental sync threw, falling back to full replace.",
      {
        error: e,
        batchBy: event.by,
        batchOrigin: event.origin,
        eventCount: event.events.length,
        firstTarget: event.events[0]?.target,
        firstDiffType: event.events[0]?.diff.type,
      },
    );
    return { tr: null, threw: true };
  }
}

/**
 * Legacy full-document rebuild. Kept as the safety net for events that the
 * incremental translator cannot (yet) handle — it is the historical behaviour
 * of this plugin and is guaranteed to leave the PM doc in a state that
 * matches Loro's view of the world.
 */
function fullReplaceFallback(
  view: EditorView,
  event: LoroEventBatch,
  state: LoroSyncPluginState,
) {
  const mapping = state.mapping;
  clearChangedNodes(state.doc as LoroDocType, event, mapping);
  const node = createNodeFromLoroObj(
    view.state.schema,
    state.containerId
      ? (state.doc.getContainerById(
          state.containerId,
        ) as LoroMap<LoroNodeContainerType>)
      : (state.doc as LoroDocType).getMap(ROOT_DOC_KEY),
    mapping,
  );

  // Only capture the local cursor when there's a meaningful chance we
  // can re-anchor it after the rebuild. For `checkout` batches the user
  // is intentionally jumping to a different document version — the local
  // cursor is no longer semantically valid, so we leave PM's natural
  // selection mapping to handle the position. Consumers using checkout
  // typically manage their own cursor placement.
  const captureCursor = event.by !== "checkout";
  const { anchor, focus } = captureCursor
    ? convertPmSelectionToCursors(view.state.doc, view.state.selection, state)
    : { anchor: undefined, focus: undefined };

  const tr = view.state.tr.replace(
    0,
    view.state.doc.content.size,
    new Slice(Fragment.from(node), 0, 0),
  );

  tr.setMeta(loroSyncPluginKey, {
    type: "non-local-updates",
  });
  view.dispatch(tr);

  if (anchor == null) {
    return;
  }
  setTimeout(() => {
    syncCursorsToPmSelection(view, anchor, focus);
  });
}

/**
 * Update ProseMirror selection based on the given Loro cursors.
 */
export function syncCursorsToPmSelection(
  view: EditorView,
  anchor: Cursor,
  focus?: Cursor,
) {
  if (view.isDestroyed) {
    return;
  }

  const state = loroSyncPluginKey.getState(view.state);
  if (!state) {
    return;
  }

  const { doc, mapping } = state;
  const anchorPos = cursorToAbsolutePosition(anchor, doc, mapping)[0];
  const focusPos = focus && cursorToAbsolutePosition(focus, doc, mapping)[0];
  if (anchorPos == null) {
    return;
  }

  // If the cursors are synced faster than the document, then the cursors might
  // be out of bounds. Thus, we need to check if the cursors are out of bounds.
  safeSetSelection(view, anchorPos, focusPos);
}
