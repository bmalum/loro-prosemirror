import type { Loro } from "loro-crdt";
import type { Schema } from "prosemirror-model";

// Cache the configured (doc, schema) pairs. We need both axes:
//   - Per-doc: don't reconfigure the same doc more than once.
//   - Per-schema: if a host application creates a second editor on the
//     same Loro doc with a different schema (different mark set), the
//     second editor MUST be allowed to register its own mark expand
//     rules — otherwise the second editor's marks would silently lose
//     their inclusive/exclusive behaviour.
const LORO_TEXT_STYLE_CACHE = new WeakMap<Loro, WeakSet<Schema>>();

function getLoroTextStyle(schema: Schema): {
  [mark: string]: { expand: "before" | "after" | "none" | "both" };
} {
  return Object.fromEntries(
    Object.entries(schema.marks).map(([markName, markType]) => [
      markName,
      { expand: markType.spec.inclusive ? "after" : "none" },
    ]),
  );
}

export function configLoroTextStyle(doc: Loro, schema: Schema) {
  let schemaSet = LORO_TEXT_STYLE_CACHE.get(doc);
  if (schemaSet == null) {
    schemaSet = new WeakSet<Schema>();
    LORO_TEXT_STYLE_CACHE.set(doc, schemaSet);
  }
  if (schemaSet.has(schema)) {
    return;
  }
  schemaSet.add(schema);
  doc.configTextStyle(getLoroTextStyle(schema));
}
