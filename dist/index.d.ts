import { Node, Schema } from "prosemirror-model";
import * as prosemirror_state0 from "prosemirror-state";
import { Command, EditorState, Plugin, PluginKey, Selection, Transaction } from "prosemirror-state";
import * as loro_crdt0 from "loro-crdt";
import { Awareness, ContainerID, Cursor, EphemeralStore, LoroDoc, LoroEventBatch, LoroList, LoroMap, LoroText, LoroTree, PeerID, Subscription, UndoManager, Value } from "loro-crdt";
import * as prosemirror_view0 from "prosemirror-view";
import { DecorationAttrs, DecorationSet, EditorView } from "prosemirror-view";
import * as delta from "lib0/delta";

//#region src/lib.d.ts
type LoroChildrenListType = LoroList<LoroMap<LoroNodeContainerType> | LoroText>;
type LoroNodeContainerType = {
  [CHILDREN_KEY]: LoroChildrenListType;
  [ATTRIBUTES_KEY]: LoroMap;
  [NODE_NAME_KEY]: string;
};
type LoroDocType = LoroDoc<{
  doc: LoroMap<LoroNodeContainerType>;
  data: LoroMap;
}>;
type LoroNode = LoroMap<LoroNodeContainerType>;
type LoroContainer = LoroChildrenListType | LoroMap<LoroNodeContainerType> | LoroText | LoroTree;
type LoroType = LoroContainer | Value;
type LoroNodeMapping = Map<ContainerID, Node | Node[]>;
declare const ROOT_DOC_KEY = "doc";
declare const ATTRIBUTES_KEY = "attributes";
declare const CHILDREN_KEY = "children";
declare const NODE_NAME_KEY = "nodeName";
declare function updateLoroToPmState(doc: LoroDocType, mapping: LoroNodeMapping, editorState: EditorState, containerId?: ContainerID): void;
/**
 * Optional error sink for `createNodeFromLoroObj`. When the function
 * fails to materialise a node (schema mismatch, invalid attrs, etc.)
 * it normally logs to `console.error` and returns null/empty. Pass an
 * `onError` callback to also receive the error programmatically — the
 * sync plugin uses this to surface failures via `onSyncEvent`.
 */
type CreateNodeErrorReporter = (error: unknown) => void;
declare function createNodeFromLoroObj(schema: Schema, obj: LoroNode, mapping: LoroNodeMapping, onError?: CreateNodeErrorReporter): Node;
declare function createNodeFromLoroObj(schema: Schema, obj: LoroText, mapping: LoroNodeMapping, onError?: CreateNodeErrorReporter): Node[];
//#endregion
//#region src/logger.d.ts
/**
 * Lightweight, level-filtered logger used by every code path that
 * historically called `console.error` / `console.warn` / `console.debug`.
 *
 * Design goals:
 *   1. Production default: `error` and `warn` go to `console.*`,
 *      `info` and `debug` are silent.
 *   2. No performance cost when `debug` is disabled — call sites pass
 *      a thunk-shaped context for `debug`/`info` so the message doesn't
 *      get formatted unless it'll be printed.
 *   3. Pluggable: consumers can pass their own `LoroLogger` (e.g. a
 *      Sentry/Datadog/Pino wrapper) into `LoroSyncPluginProps.logger`
 *      and `LoroUndoPluginProps.logger`.
 *   4. No global state / module-level mutation — every plugin instance
 *      has its own logger. Hot-reload safe.
 */
type LoroLogLevel = "silent" | "error" | "warn" | "info" | "debug";
interface LoroLogger {
  /** Always-on by default. Use for unrecoverable errors. */
  error(message: string, context?: Record<string, unknown>): void;
  /** Always-on by default. Use for recoverable / soft failures. */
  warn(message: string, context?: Record<string, unknown>): void;
  /** Off by default. Use for plugin lifecycle milestones. */
  info(message: string, context?: Record<string, unknown>): void;
  /** Off by default. Use for hot-path tracing. */
  debug(message: string, context?: Record<string, unknown>): void;
}
/**
 * Default factory: a console-backed logger filtered by level.
 *
 * Usage:
 * ```ts
 * LoroSyncPlugin({
 *   doc,
 *   logger: createConsoleLogger("debug"),  // verbose
 * });
 * LoroSyncPlugin({
 *   doc,
 *   logger: createConsoleLogger("warn"),   // production default
 * });
 * ```
 */
declare function createConsoleLogger(level?: LoroLogLevel, prefix?: string): LoroLogger;
/**
 * No-op logger. Useful in tests where any console output would be
 * noise, or in performance-sensitive paths where the logger is
 * threaded but logging is unwanted.
 */
declare const silentLogger: LoroLogger;
/**
 * The fallback logger used when a plugin is constructed without a
 * `logger` prop. Production-safe defaults: `error` and `warn` print
 * via `console.*`; `info` and `debug` are silent.
 */
declare const defaultLogger: LoroLogger;
//#endregion
//#region src/sync-plugin-key.d.ts
declare const loroSyncPluginKey: PluginKey<LoroSyncPluginState>;
/**
 * Stable string constants for the meta values the plugin attaches to
 * its own transactions. Consumers should pattern-match against these
 * (rather than hard-coding the strings) when writing custom
 * `appendTransaction` plugins that need to react to plugin-internal
 * transactions.
 *
 * Example: a host editor's "stamp missing block IDs on transactions"
 * extension typically wants to skip stamping during a Loro-driven
 * dispatch, since the blocks will already carry server-stamped IDs:
 *
 * ```ts
 * import { LORO_SYNC_META, getLoroSyncMeta } from "loro-prosemirror";
 *
 * appendTransaction(transactions) {
 *   if (transactions.some(tr => {
 *     const m = getLoroSyncMeta(tr);
 *     return m?.type === LORO_SYNC_META.NON_LOCAL_UPDATES ||
 *            m?.type === LORO_SYNC_META.UPDATE_STATE;
 *   })) return null;
 *   // …user-edit handling
 * }
 * ```
 */
declare const LORO_SYNC_META: {
  /** PM-side edit landed; the plugin will write it to Loro. */readonly DOC_CHANGED: "doc-changed"; /** A remote (or undo) Loro batch was applied to PM. */
  readonly NON_LOCAL_UPDATES: "non-local-updates"; /** Plugin internal state update (typically the bootstrap dispatch). */
  readonly UPDATE_STATE: "update-state";
};
type LoroSyncMetaType = (typeof LORO_SYNC_META)[keyof typeof LORO_SYNC_META];
/**
 * Shape of the meta value the plugin attaches to its transactions.
 * Useful as a discriminator in custom `appendTransaction` handlers.
 *
 * Discriminated by `type`. Extra fields per branch are intentionally
 * not part of the public type — the wire format is internal and may
 * change. Match on `type` only.
 */
interface LoroSyncTransactionMeta {
  type: LoroSyncMetaType;
}
/**
 * Returns the loroSyncPlugin's meta on this transaction, or `null` if
 * the transaction is not plugin-internal. Equivalent to
 * `tr.getMeta(loroSyncPluginKey) as LoroSyncTransactionMeta | null`
 * but lets consumers avoid importing the plugin key just for this.
 */
declare function getLoroSyncMeta(tr: Transaction): LoroSyncTransactionMeta | null;
/**
 * Convenience predicate: did the loroSyncPlugin originate this
 * transaction? Hosts use this to skip echo passes (e.g. don't
 * re-stamp block IDs on a remote-driven `non-local-updates` tx).
 */
declare function isLoroInternalTransaction(tr: Transaction): boolean;
/**
 * A single notification emitted by the sync plugin describing how it
 * processed a Loro event batch. Wire up via `LoroSyncPluginProps.onSyncEvent`
 * to surface metrics, debug, or telemetry from your application.
 */
type LoroSyncEvent = {
  kind: "init";
  /**
   * What the plugin did during the initial bootstrap dispatch:
   *   - `loro-populated` — the Loro doc had content; PM was replaced
   *     with the materialised tree. NO local Loro commits emitted.
   *   - `pm-seeded` — PM had content and Loro was empty; the plugin
   *     wrote PM into Loro as the initial seed. **Local Loro commits
   *     ARE emitted in this mode** — host wire-push layers should
   *     treat them as expected, not as runtime regressions.
   *   - `both-empty` — neither side had content; the mapping was
   *     bound but no Loro writes happened.
   */
  mode: "loro-populated" | "pm-seeded" | "both-empty";
} | {
  kind: "incremental"; /** Number of `LoroEvent`s in the batch. */
  eventCount: number; /** Loro's classification of how the batch was triggered. */
  by: "local" | "import" | "checkout"; /** `event.origin` from the Loro batch (e.g. "undo"), if any. */
  origin?: string;
} | {
  kind: "fallback";
  /**
   * Why the incremental translator declined this batch:
   *   - `translator-null` — `loroEventBatchToTransaction` returned null
   *     (a diff kind it can't yet handle, an unmapped container, a
   *     schema-violating insert, …)
   *   - `translator-threw` — the translator raised; details are also
   *     emitted via the configured `logger.error` channel.
   *   - `checkout` — `event.by === "checkout"` is intentionally routed
   *     to the rebuild because checkout shapes can rewrite the doc.
   */
  reason: "translator-null" | "translator-threw" | "checkout";
  eventCount: number;
  by: "local" | "import" | "checkout";
  origin?: string;
} | {
  kind: "error";
  /**
   * Where the error originated:
   *   - `init` — the plugin's initial bootstrap (Loro→PM replace, or
   *     PM→Loro initial seed) threw. The editor still mounts but
   *     stays unsynced until the next event.
   *   - `doc-changed` — `updateLoroToPmState` threw while writing PM->Loro
   *     (typically a node-name mismatch from a divergent merge).
   *   - `update-state` — Loro `commit()` threw inside the plugin's
   *     `update-state` apply branch.
   *   - `cursor-encode` — encoding the local PM selection as a Loro
   *     cursor failed (mapping miss, range out of bounds, etc.).
   *   - `cursor-decode` — decoding a remote Loro cursor to a PM
   *     position failed (unmapped container, broken reference, etc.).
   *   - `materialize` — `createNodeFromLoroObj` rejected a Loro tree
   *     (schema validation, invalid nodeName, etc.).
   */
  phase: "init" | "doc-changed" | "update-state" | "cursor-encode" | "cursor-decode" | "materialize";
  error: unknown;
};
interface LoroSyncPluginProps {
  doc: LoroDocType;
  mapping?: LoroNodeMapping;
  containerId?: ContainerID;
  /**
   * Optional metrics / telemetry hook fired once per Loro event batch the
   * plugin handles, plus an `init` event after the bootstrap dispatch.
   * Use it to track incremental-vs-fallback ratios, fallback reasons,
   * batch sizes, etc. Throwing here is caught and logged — the plugin
   * never lets a hook error break the dispatch.
   */
  onSyncEvent?: (event: LoroSyncEvent) => void;
  /**
   * When true, the plugin's `fullReplaceFallback` path does NOT
   * automatically restore the local cursor via
   * `syncCursorsToPmSelection` after the doc rebuild. Set this in
   * editors that handle cursor restoration themselves — typically via
   * a custom `appendTransaction` plugin that reads
   * `LORO_SYNC_META.NON_LOCAL_UPDATES` from the dispatched transaction
   * and re-sets the selection synchronously.
   *
   * Default: `false` (the plugin schedules a `queueMicrotask` cursor
   * restore using Loro cursors captured before the rebuild).
   *
   * Hosts that ARE running a competing CursorGuard pattern should set
   * this to `true` — otherwise the plugin's microtask runs AFTER the
   * host's `appendTransaction` and overrides its selection.
   */
  disableFallbackCursorRestore?: boolean;
  /**
   * Optional structured logger. When omitted, the plugin uses a
   * built-in console logger that prints `error` and `warn` only.
   * Pass `createConsoleLogger("debug")` to enable verbose tracing,
   * or your own implementation to forward to a structured backend
   * (Sentry, Datadog, Pino, etc.).
   */
  logger?: LoroLogger;
}
interface LoroSyncPluginState extends LoroSyncPluginProps {
  changedBy: "local" | "import" | "checkout";
  mapping: LoroNodeMapping;
  /**
   * @deprecated Reserved for a future read-only snapshot mode. Currently
   * always null after init; the `editable` plugin prop returns true
   * regardless. Do not depend on this field — it may be removed in a
   * future major.
   */
  snapshot?: LoroDoc | null;
  /**
   * @deprecated Never written by the plugin. Slated for removal.
   */
  view?: EditorView;
  containerId?: ContainerID;
  docSubscription?: Subscription | null;
}
//#endregion
//#region src/sync-plugin.d.ts
declare const LoroSyncPlugin: (props: LoroSyncPluginProps) => Plugin;
//#endregion
//#region src/incremental-sync.d.ts
/**
 * Information about where a Loro container resides in the ProseMirror tree.
 */
interface ContainerLocation {
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
 * has not been re-walked, or when a `LoroText` has been emptied and pruned
 * from the mapping by `updateLoroToPmState`. Callers handling text events
 * should fall back to {@link findEmptyTextPosition} in that case.
 *
 * Pass an optional `cache` to memoise lookups across an event batch — the
 * walk over `doc.descendants` is O(N) per call, so without a cache a
 * batch of M events on a doc of size N is O(N·M).
 */
declare function findContainerLocation(doc: Node, containerId: ContainerID, mapping: LoroNodeMapping, cache?: Map<ContainerID, ContainerLocation | null>): ContainerLocation | null;
/**
 * Resolve the PM position of a `LoroText` whose mapping entry is missing
 * (typically because `updateLoroToPmState` pruned it after the LoroText
 * was fully emptied).
 *
 * The position is computed by walking the parent block's children list in
 * Loro and summing the PM `nodeSize` of the preceding mapped children.
 *
 * IMPORTANT: this function must NOT be called when the parent block's
 * children list has been mutated earlier in the same event batch — the
 * walk uses Loro's post-batch state but the returned position is in
 * pre-batch PM coordinates, and a sibling insert/delete in this batch
 * would silently shift the offset. Callers must guard with
 * `parentTouchedInBatch` (see {@link loroEventBatchToTransaction}).
 *
 * Returns `null` if the parent block is itself unmapped or the text
 * container is no longer in its parent.
 */
declare function findEmptyTextPosition(pmDoc: Node, textId: ContainerID, mapping: LoroNodeMapping, loroDoc: LoroDocType): number | null;
/**
 * Translate a `LoroEventBatch` into a ProseMirror `Transaction`.
 *
 * Returns `null` when any event in the batch cannot be translated — the
 * caller MUST fall back to a full document replace in that case so the
 * doc never diverges from Loro.
 *
 * Handled diff kinds:
 *   - `text`: insert / delete / mark add / mark remove inside a `LoroText`
 *   - `list`: block insert / delete / move on a parent's children list
 *   - `map`:  attribute updates on a block's `attributes` sub-map
 *
 * Other diff kinds (`tree`, `counter`) and any `event.by === "checkout"`
 * batch are routed to the fallback.
 */
declare function loroEventBatchToTransaction(state: EditorState, batch: LoroEventBatch, mapping: LoroNodeMapping, doc: LoroDocType): Transaction | null;
//#endregion
//#region src/cursor/common.d.ts
type CursorUser = {
  name: string;
  color: string;
};
type CursorPresenceState = {
  anchor?: Cursor;
  focus?: Cursor;
  user?: CursorUser;
};
interface CursorPluginOptions {
  getSelection?: (state: EditorState) => Selection;
  createCursor?: (user: PeerID) => Element;
  createSelection?: (user: PeerID) => DecorationAttrs;
  user?: CursorUser;
}
declare function convertPmSelectionToCursors(pmRootNode: Node, selection: Selection, loroState: LoroSyncPluginState): {
  anchor: Cursor | undefined;
  focus: Cursor | undefined;
};
declare function absolutePositionToCursor(pmRootNode: Node, anchor: number, doc: LoroDocType, mapping: LoroNodeMapping): Cursor | undefined;
declare function cursorToAbsolutePosition(cursor: Cursor, doc: LoroDocType, mapping: LoroNodeMapping): [number | null, Cursor | undefined];
//#endregion
//#region src/cursor/ephemeral.d.ts
type CursorEphemeralPayload = {
  anchor: Uint8Array | null;
  focus: Uint8Array | null;
  user: {
    name: string;
    color: string;
  } | null;
};
type CursorEphemeralStateMap = Record<string, CursorEphemeralPayload>;
declare class CursorEphemeralStore extends EphemeralStore<CursorEphemeralStateMap> {
  private peer;
  constructor(peer: PeerID, timeout?: number);
  setLocal(state: CursorPresenceState): void;
  getLocal(): CursorPresenceState | undefined;
  getAll(): { [peer in PeerID]: CursorPresenceState };
  subscribeBy(listener: (by: "local" | "import" | "timeout") => void): () => void;
}
declare const LoroEphemeralCursorPlugin: (store: CursorEphemeralStore, options: CursorPluginOptions) => prosemirror_state0.Plugin<prosemirror_view0.DecorationSet>;
//#endregion
//#region src/cursor/awareness.d.ts
declare class CursorAwareness extends Awareness<{
  anchor: Uint8Array | null;
  focus: Uint8Array | null;
  user: {
    name: string;
    color: string;
  } | null;
}> {
  constructor(peer: PeerID, timeout?: number);
  getAll(): { [peer in PeerID]: {
    anchor?: Cursor;
    focus?: Cursor;
  } };
  setLocal(state: {
    anchor?: Cursor;
    focus?: Cursor;
    user?: {
      name: string;
      color: string;
    };
  }): void;
  getLocal(): {
    anchor: Cursor | null;
    focus: Cursor | null;
    user: {
      name: string;
      color: string;
    } | null;
  } | undefined;
}
declare const LoroCursorPlugin: (awareness: CursorAwareness, options: CursorPluginOptions) => prosemirror_state0.Plugin<prosemirror_view0.DecorationSet>;
//#endregion
//#region src/undo-plugin-key.d.ts
declare const loroUndoPluginKey: PluginKey<LoroUndoPluginState>;
interface LoroUndoPluginProps {
  doc: LoroDoc;
  undoManager?: UndoManager;
  /**
   * Optional structured logger. When omitted, the plugin uses a
   * built-in console logger that prints `error` and `warn` only.
   */
  logger?: LoroLogger;
}
interface LoroUndoPluginState {
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
  isUndoing: {
    current: boolean;
  };
  /**
   * Selection captured BEFORE the last user transaction was applied.
   * Used by the `UndoManager.setOnPush` callback to remember where the
   * cursor was before the edit, so an `undo()` lands the cursor back
   * at that position. `null` until the first user transaction.
   */
  prevSelection: {
    anchor: Cursor | null;
    focus: Cursor | null;
  } | null;
}
//#endregion
//#region src/undo-plugin.d.ts
declare const LoroUndoPlugin: (props: LoroUndoPluginProps) => Plugin;
declare function canUndo(state: EditorState): boolean;
declare function canRedo(state: EditorState): boolean;
declare const undo: Command;
declare const redo: Command;
//#endregion
//#region src/pm-diff.d.ts
/**
 * Convert a ProseMirror node to a lib0 delta.
 * Text nodes → text ops. Block nodes → insert ops with nested delta.
 */
declare function nodeToDelta(node: Node): delta.DeltaAny;
/**
 * Apply a lib0 delta diff as real ProseMirror steps on the transaction.
 * Adapted from y-prosemirror's deltaToPSteps.
 */
declare function deltaToPSteps(tr: Transaction, d: delta.DeltaAny, pnode?: Node, currPos?: {
  i: number;
}): Transaction;
/**
 * Compute the minimal diff between two PM docs and apply it as real PM steps.
 * Uses the Loro-derived nodes (from createNodeFromLoroObj) for changed blocks,
 * which ensures WEAK_NODE_TO_LORO_CONTAINER_MAPPING entries are set correctly.
 *
 * Returns the transaction with the steps applied, or null if docs are identical.
 */
declare function diffPmDocs(tr: Transaction, oldDoc: Node, newDoc: Node): Transaction | null;
/**
 * After diffPmDocs, the new PM doc has nodes created by deltaToPNode which
 * don't have WEAK_NODE_TO_LORO_CONTAINER_MAPPING entries. This function walks
 * the Loro doc and the new PM doc in parallel to rebuild the mapping.
 *
 * The Loro doc and the new PM doc have the same structure (that's the point
 * of the diff), so we can walk them together and establish the correspondence.
 */
declare function rebuildMappingAfterDiff(loroDoc: LoroDocType, pmDoc: Node, mapping: LoroNodeMapping, containerId?: loro_crdt0.ContainerID): void;
//#endregion
export { ATTRIBUTES_KEY, CHILDREN_KEY, type ContainerLocation, CursorAwareness, CursorEphemeralStore, type CursorPluginOptions, type CursorPresenceState, type CursorUser, LORO_SYNC_META, type LoroChildrenListType, type LoroContainer, LoroCursorPlugin, type LoroDocType, LoroEphemeralCursorPlugin, type LoroLogLevel, type LoroLogger, type LoroNode, type LoroNodeContainerType, type LoroNodeMapping, type LoroSyncEvent, type LoroSyncMetaType, LoroSyncPlugin, type LoroSyncPluginProps, type LoroSyncPluginState, type LoroSyncTransactionMeta, type LoroType, LoroUndoPlugin, type LoroUndoPluginProps, NODE_NAME_KEY, ROOT_DOC_KEY, absolutePositionToCursor, canRedo, canUndo, convertPmSelectionToCursors, createConsoleLogger, createNodeFromLoroObj, cursorToAbsolutePosition, defaultLogger, deltaToPSteps, diffPmDocs, findContainerLocation, findEmptyTextPosition, getLoroSyncMeta, isLoroInternalTransaction, loroEventBatchToTransaction, loroSyncPluginKey, loroUndoPluginKey, nodeToDelta, rebuildMappingAfterDiff, redo, silentLogger, undo, updateLoroToPmState };
//# sourceMappingURL=index.d.ts.map