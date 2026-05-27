import type { Cursor, LoroEventBatch, LoroMap, Subscription } from "loro-crdt";
import { Fragment, Slice } from "prosemirror-model";
import { Plugin, type StateField } from "prosemirror-state";
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
import { defaultLogger, type LoroLogger } from "./logger";

type PluginTransactionType =
  | { type: "doc-changed" }
  | {
      type: "non-local-updates";
      /** Loro's classification of the source of the upstream change. */
      changedBy: "import" | "checkout" | "local";
    }
  | {
      type: "update-state";
      state: Partial<LoroSyncPluginState>;
      /**
       * Whether to commit Loro with `sys:init` origin after merging the
       * partial state. Only the initial bootstrap from `init()` sets this.
       */
      commitInit?: boolean;
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
          disableFallbackCursorRestore: props.disableFallbackCursorRestore,
          logger: props.logger ?? defaultLogger,
        };
      },
      apply: (
        tr,
        state,
        oldEditorState,
        newEditorState,
      ): LoroSyncPluginState => {
        const meta = tr.getMeta(
          loroSyncPluginKey,
        ) as PluginTransactionType | null;
        const undoState = loroUndoPluginKey.getState(oldEditorState);

        switch (meta?.type) {
          case "non-local-updates":
            // Upstream Loro change — record where it came from. Critically
            // we do NOT call `updateLoroToPmState` here: the diff was just
            // applied PM-side from a Loro event, echoing it back would loop.
            return state.changedBy === meta.changedBy
              ? state
              : { ...state, changedBy: meta.changedBy };

          case "doc-changed": {
            // PM-side edit happened — push it to Loro. Skip while an undo
            // is in flight so the undo's PM transaction doesn't echo back.
            if (!undoState?.isUndoing.current) {
              try {
                updateLoroToPmState(
                  state.doc as LoroDocType,
                  state.mapping,
                  newEditorState,
                  state.containerId,
                );
                getLogger(state).debug("doc-changed: PM->Loro write");
              } catch (e) {
                emitSyncEvent(state, {
                  kind: "error",
                  phase: "doc-changed",
                  error: e,
                });
                getLogger(state).error(
                  "updateLoroToPmState threw, doc may diverge until next event",
                  { error: e },
                );
              }
            }
            return state.changedBy === "local"
              ? state
              : { ...state, changedBy: "local" };
          }

          case "update-state": {
            const next: LoroSyncPluginState = { ...state, ...meta.state };
            if (meta.commitInit) {
              try {
                next.doc.commit({
                  origin: "sys:init",
                  timestamp: Date.now(),
                });
              } catch (e) {
                emitSyncEvent(next, {
                  kind: "error",
                  phase: "update-state",
                  error: e,
                });
                getLogger(next).error("sys:init commit threw", { error: e });
              }
            }
            return next;
          }

          default:
            return state;
        }
      },
    } as StateField<LoroSyncPluginState>,
    appendTransaction: (transactions, _oldEditorState, newEditorState) => {
      // Only echo PM->Loro for transactions that are user/host edits, not
      // the plugin's own non-local-updates / update-state transactions.
      // Otherwise an upstream Loro event triggers a PM dispatch that we'd
      // immediately re-export to Loro (echo loop).
      const isInternal = transactions.some(
        (tr) => tr.getMeta(loroSyncPluginKey) != null,
      );
      if (isInternal) {
        return null;
      }
      if (transactions.some((tr) => tr.docChanged)) {
        return newEditorState.tr.setMeta(loroSyncPluginKey, {
          type: "doc-changed",
        });
      }
      return null;
    },
    view: (view: EditorView) => {
      // Capture the unsubscribe in a closure so `destroy()` can clean up
      // even when init's dispatch throws and the plugin state never lands
      // the docSubscription field. Without this the subscription would
      // leak forever on a botched mount.
      let unsubscribe: (() => void) | null = null;
      try {
        unsubscribe = init(view, props);
      } catch (e) {
        // Wrap the whole bootstrap. A throw out of view() during PM's
        // updatePluginViews loop would interrupt plugin installation
        // and leave the editor half-mounted. We absorb the error,
        // emit it via onSyncEvent, and let the editor mount as a
        // read-mostly view (the next remote event will still try to
        // sync).
        const state = loroSyncPluginKey.getState(view.state);
        if (state != null) {
          emitSyncEvent(state, { kind: "error", phase: "init", error: e });
        }
        (state?.logger ?? defaultLogger).error(
          "init threw, editor mounted unsynced",
          { error: e },
        );
      }
      return {
        update: (_view: EditorView, _prevState) => {},
        destroy: () => {
          unsubscribe?.();
          unsubscribe = null;
        },
      };
    },
  });
};

/**
 * Run the bootstrap dispatch that wires PM to Loro. Synchronous so a
 * user keystroke landed before the plugin mounted cannot be silently
 * clobbered (the `setTimeout` version had this race).
 *
 * Returns the unsubscribe function for the Loro subscription so the
 * caller can hold it in a closure independent of plugin state. If the
 * bootstrap dispatch throws, the unsubscribe is called before the
 * throw propagates.
 */
function init(view: EditorView, props: LoroSyncPluginProps): () => void {
  if (view.isDestroyed) {
    return () => {};
  }

  const state = loroSyncPluginKey.getState(view.state);
  if (state == null) {
    // The plugin's `state.init` should have populated this before
    // `view()` runs. If it didn't, something is very wrong — but we
    // throw rather than silently no-op so it's loud during development.
    throw new Error(
      "[loro-prosemirror] LoroSyncPlugin state was not initialised before view() ran",
    );
  }

  // Subscribe FIRST so we don't miss events emitted by our own bootstrap
  // commit. The subscription handler (updateNodeOnLoroEvent) filters
  // local non-undo events, so the sys:init batch is not re-applied.
  let docSubscription: Subscription;
  if (state.containerId) {
    const container = state.doc.getContainerById(state.containerId);
    if (container == null) {
      throw new Error(
        `[loro-prosemirror] containerId ${String(
          state.containerId,
        )} not found in Loro doc`,
      );
    }
    docSubscription = container.subscribe((event) => {
      updateNodeOnLoroEvent(view, event);
    });
  } else {
    docSubscription = state.doc.subscribe((event) =>
      updateNodeOnLoroEvent(view, event),
    );
  }

  // Wrap the dispatch in try/catch so a schema mismatch or invalid
  // content cannot leak the subscription.
  try {
    bootstrapDispatch(view, state, docSubscription);
  } catch (e) {
    docSubscription();
    throw e;
  }

  return docSubscription;
}

/**
 * Decide which initial-sync direction to take and dispatch the bootstrap
 * transaction. Three cases (also surfaced via `onSyncEvent` as
 * `{ kind: "init", mode: ... }` so consumers know what happened):
 *   1. `both-empty`: Loro empty + PM empty — just bind the empty mapping.
 *      No Loro commits emitted.
 *   2. `pm-seeded`: Loro empty + PM has content — write PM into Loro
 *      (initial seed). Avoids the silent-content-clobber bug where a
 *      host loaded saved content into PM and attached the sync plugin
 *      to a fresh Loro doc. **Local Loro commits ARE emitted in this
 *      mode** — host wire-push layers should expect them.
 *   3. `loro-populated`: Loro has content — replace PM with Loro's
 *      tree. Commits Loro with `sys:init` origin (no-op when nothing
 *      was buffered, which is the common case).
 */
function bootstrapDispatch(
  view: EditorView,
  state: LoroSyncPluginState,
  docSubscription: Subscription,
): void {
  const innerDoc = state.containerId
    ? (state.doc.getContainerById(
        state.containerId,
      ) as LoroMap<LoroNodeContainerType>)
    : (state.doc as LoroDocType).getMap(ROOT_DOC_KEY);

  const mapping: LoroNodeMapping = new Map();
  const pmIsEmpty = isPmDocEmpty(view.state.doc);

  if (innerDoc.size === 0 && pmIsEmpty) {
    // Case 1: both empty. Nothing to copy; just register state.
    const tr = view.state.tr;
    tr.setMeta(loroSyncPluginKey, {
      type: "update-state",
      state: { mapping, docSubscription, snapshot: null },
      commitInit: false,
    });
    tr.setMeta("addToHistory", false);
    view.dispatch(tr);
    emitSyncEvent(state, { kind: "init", mode: "both-empty" });
    return;
  }

  if (innerDoc.size === 0 && !pmIsEmpty) {
    // Case 2: PM has content, Loro is empty — seed Loro from PM. Run
    // updateLoroToPmState directly (it handles the empty-Loro case as
    // an initial population) and bind the resulting mapping.
    updateLoroToPmState(
      state.doc as LoroDocType,
      mapping,
      view.state,
      state.containerId,
    );
    const tr = view.state.tr;
    tr.setMeta(loroSyncPluginKey, {
      type: "update-state",
      state: { mapping, docSubscription, snapshot: null },
      commitInit: false,
    });
    tr.setMeta("addToHistory", false);
    view.dispatch(tr);
    emitSyncEvent(state, { kind: "init", mode: "pm-seeded" });
    return;
  }

  // Case 3: Loro has content — materialise it into PM and replace.
  const schema = view.state.schema;
  const node = createNodeFromLoroObj(
    schema,
    innerDoc as LoroMap<LoroNodeContainerType>,
    mapping,
    (e) =>
      emitSyncEvent(state, { kind: "error", phase: "materialize", error: e }),
  );
  if (node == null) {
    throw new Error(
      "[loro-prosemirror] createNodeFromLoroObj returned null for the root container",
    );
  }
  const tr = view.state.tr.replace(
    0,
    view.state.doc.content.size,
    new Slice(Fragment.from(node), 0, 0),
  );
  tr.setMeta(loroSyncPluginKey, {
    type: "update-state",
    state: { mapping, docSubscription, snapshot: null },
    commitInit: true,
  });
  tr.setMeta("addToHistory", false);
  view.dispatch(tr);
  emitSyncEvent(state, { kind: "init", mode: "loro-populated" });
}

/**
 * Heuristic for "the host did not put any user content in PM yet". A
 * fresh `EditorState.create({schema, plugins})` produces a doc whose
 * `content.size` is zero (the doc node itself contributes opening/
 * closing tokens but those are outside `content.size`). We rely on
 * that to decide whether case 1 or case 2 applies.
 */
function isPmDocEmpty(doc: import("prosemirror-model").Node): boolean {
  return doc.content.size === 0;
}

function updateNodeOnLoroEvent(view: EditorView, event: LoroEventBatch) {
  if (view.isDestroyed) {
    return;
  }

  const state = loroSyncPluginKey.getState(view.state);
  if (state == null) {
    // Plugin state was never initialized OR has already been torn
    // down. Either way we have no logger / onSyncEvent / mapping to
    // work with — silently ignore the event.
    return;
  }
  if (event.by === "local" && event.origin !== "undo") {
    // Our own write that doesn't come from an undo replay. The PM dispatch
    // that produced this Loro change has already updated the editor; we
    // don't need to round-trip it back into PM.
    getLogger(state).debug("skip own local non-undo event", {
      origin: event.origin,
      eventCount: event.events.length,
    });
    return;
  }
  getLogger(state).debug("processing Loro event batch", {
    by: event.by,
    origin: event.origin,
    eventCount: event.events.length,
  });

  // First try to translate the event batch into surgical PM Steps. When the
  // translation succeeds we dispatch a single transaction and rely on PM's
  // built-in selection mapping to keep the cursor in place — no manual
  // `setTimeout(syncCursorsToPmSelection)` dance is needed.
  //
  // When the translator returns null (or throws) we fall back to the legacy
  // full-document rebuild so the doc never diverges. This is the safety net.
  const { tr: incrementalTr, threw } = tryIncrementalSync(view, event, state);
  if (incrementalTr != null) {
    incrementalTr.setMeta(loroSyncPluginKey, {
      type: "non-local-updates",
      changedBy: event.by,
    });
    incrementalTr.setMeta("addToHistory", false);
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
 * Resolve the logger for a given plugin state. Falls back to the
 * default console logger if the state predates the logger field
 * (defensive — should never fire in practice).
 */
function getLogger(state: LoroSyncPluginState): LoroLogger {
  return state.logger ?? defaultLogger;
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
    getLogger(state).error("onSyncEvent hook threw", { error: e });
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
    getLogger(state).error(
      "incremental sync threw, falling back to full replace",
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
    (e) =>
      emitSyncEvent(state, { kind: "error", phase: "materialize", error: e }),
  );
  if (node == null) {
    emitSyncEvent(state, {
      kind: "error",
      phase: "materialize",
      error: new Error("createNodeFromLoroObj returned null on rebuild"),
    });
    return;
  }

  // Only capture the local cursor when there's a meaningful chance we
  // can re-anchor it after the rebuild. For `checkout` batches the user
  // is intentionally jumping to a different document version — the local
  // cursor is no longer semantically valid, so we leave PM's natural
  // selection mapping to handle the position. Consumers using checkout
  // typically manage their own cursor placement.
  const captureCursor = event.by !== "checkout";
  let anchor: Cursor | undefined;
  let focus: Cursor | undefined;
  if (captureCursor) {
    try {
      const encoded = convertPmSelectionToCursors(
        view.state.doc,
        view.state.selection,
        state,
      );
      anchor = encoded.anchor;
      focus = encoded.focus;
    } catch (e) {
      emitSyncEvent(state, { kind: "error", phase: "cursor-encode", error: e });
    }
  }

  const tr = view.state.tr.replace(
    0,
    view.state.doc.content.size,
    new Slice(Fragment.from(node), 0, 0),
  );

  tr.setMeta(loroSyncPluginKey, {
    type: "non-local-updates",
    changedBy: event.by,
  });
  tr.setMeta("addToHistory", false);
  view.dispatch(tr);

  if (anchor == null) {
    return;
  }
  if (state.disableFallbackCursorRestore) {
    // Host has its own cursor-restore mechanism (typically an
    // `appendTransaction` that detects `LORO_SYNC_META.NON_LOCAL_UPDATES`
    // and re-sets the selection synchronously during the same tx
    // batch). Running our microtask afterwards would override the
    // host's chosen position with our Loro-cursor round-trip, which
    // can be slightly less accurate.
    return;
  }
  // Defer with queueMicrotask (instead of setTimeout) so the selection
  // restore runs at the next microtask checkpoint — same task, so any
  // synchronous follow-up still observes the correct cursor.
  queueMicrotask(() => {
    syncCursorsToPmSelection(view, anchor!, focus);
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
  const focusPos = focus
    ? cursorToAbsolutePosition(focus, doc, mapping)[0]
    : undefined;
  if (anchorPos == null) {
    return;
  }

  // If the cursors are synced faster than the document, then the cursors might
  // be out of bounds. Thus, we need to check if the cursors are out of bounds.
  safeSetSelection(view, anchorPos, focusPos ?? undefined);
}
