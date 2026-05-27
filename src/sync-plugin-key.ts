import type { ContainerID, LoroDoc, Subscription } from "loro-crdt";
import { PluginKey, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { LoroDocType, LoroNodeMapping } from "./lib";
import type { LoroLogger } from "./logger";

export const loroSyncPluginKey = new PluginKey<LoroSyncPluginState>(
  "loro-sync",
);

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
export const LORO_SYNC_META = {
  /** PM-side edit landed; the plugin will write it to Loro. */
  DOC_CHANGED: "doc-changed",
  /** A remote (or undo) Loro batch was applied to PM. */
  NON_LOCAL_UPDATES: "non-local-updates",
  /** Plugin internal state update (typically the bootstrap dispatch). */
  UPDATE_STATE: "update-state",
} as const;

export type LoroSyncMetaType =
  (typeof LORO_SYNC_META)[keyof typeof LORO_SYNC_META];

/**
 * Shape of the meta value the plugin attaches to its transactions.
 * Useful as a discriminator in custom `appendTransaction` handlers.
 *
 * Discriminated by `type`. Extra fields per branch are intentionally
 * not part of the public type — the wire format is internal and may
 * change. Match on `type` only.
 */
export interface LoroSyncTransactionMeta {
  type: LoroSyncMetaType;
}

/**
 * Returns the loroSyncPlugin's meta on this transaction, or `null` if
 * the transaction is not plugin-internal. Equivalent to
 * `tr.getMeta(loroSyncPluginKey) as LoroSyncTransactionMeta | null`
 * but lets consumers avoid importing the plugin key just for this.
 */
export function getLoroSyncMeta(
  tr: Transaction,
): LoroSyncTransactionMeta | null {
  const meta = tr.getMeta(loroSyncPluginKey);
  return (meta as LoroSyncTransactionMeta | null) ?? null;
}

/**
 * Convenience predicate: did the loroSyncPlugin originate this
 * transaction? Hosts use this to skip echo passes (e.g. don't
 * re-stamp block IDs on a remote-driven `non-local-updates` tx).
 */
export function isLoroInternalTransaction(tr: Transaction): boolean {
  return getLoroSyncMeta(tr) != null;
}

/**
 * A single notification emitted by the sync plugin describing how it
 * processed a Loro event batch. Wire up via `LoroSyncPluginProps.onSyncEvent`
 * to surface metrics, debug, or telemetry from your application.
 */
export type LoroSyncEvent =
  | {
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
    }
  | {
      kind: "incremental";
      /** Number of `LoroEvent`s in the batch. */
      eventCount: number;
      /** Loro's classification of how the batch was triggered. */
      by: "local" | "import" | "checkout";
      /** `event.origin` from the Loro batch (e.g. "undo"), if any. */
      origin?: string;
    }
  | {
      kind: "fallback";
      /**
       * Why the incremental translator declined this batch:
       *   - `translator-null` — `loroEventBatchToTransaction` returned null
       *     (a diff kind it can't yet handle, an unmapped container, a
       *     schema-violating insert, …)
       *   - `translator-threw` — the translator raised; details are also
       *     emitted to console.error.
       *   - `checkout` — `event.by === "checkout"` is intentionally routed
       *     to the rebuild because checkout shapes can rewrite the doc.
       */
      reason: "translator-null" | "translator-threw" | "checkout";
      eventCount: number;
      by: "local" | "import" | "checkout";
      origin?: string;
    }
  | {
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
      phase:
        | "init"
        | "doc-changed"
        | "update-state"
        | "cursor-encode"
        | "cursor-decode"
        | "materialize";
      error: unknown;
    };

export interface LoroSyncPluginProps {
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

export interface LoroSyncPluginState extends LoroSyncPluginProps {
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
