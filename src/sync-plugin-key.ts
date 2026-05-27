import type { ContainerID, LoroDoc, Subscription } from "loro-crdt";
import { PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { LoroDocType, LoroNodeMapping } from "./lib";

export const loroSyncPluginKey = new PluginKey<LoroSyncPluginState>(
  "loro-sync",
);

/**
 * A single notification emitted by the sync plugin describing how it
 * processed a Loro event batch. Wire up via `LoroSyncPluginProps.onSyncEvent`
 * to surface metrics, debug, or telemetry from your application.
 */
export type LoroSyncEvent =
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
   * plugin handles. Use it to track incremental-vs-fallback ratios,
   * fallback reasons, batch sizes, etc. Throwing here is caught and logged
   * — the plugin never lets a hook error break the dispatch.
   */
  onSyncEvent?: (event: LoroSyncEvent) => void;
}

export interface LoroSyncPluginState extends LoroSyncPluginProps {
  changedBy: "local" | "import" | "checkout";
  mapping: LoroNodeMapping;
  snapshot?: LoroDoc | null;
  view?: EditorView;
  containerId?: ContainerID;
  docSubscription?: Subscription | null;
}
