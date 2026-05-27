import {
  type ContainerID,
  Cursor,
  isContainerId,
  LoroList,
  LoroText,
  type PeerID,
} from "loro-crdt";
import { Node } from "prosemirror-model";
import { EditorState, Plugin, PluginKey, Selection } from "prosemirror-state";
import {
  Decoration,
  type DecorationAttrs,
  DecorationSet,
} from "prosemirror-view";

import {
  CHILDREN_KEY,
  type LoroDocType,
  type LoroNode,
  type LoroNodeMapping,
  WEAK_NODE_TO_LORO_CONTAINER_MAPPING,
} from "../lib";
import {
  loroSyncPluginKey,
  type LoroSyncPluginState,
} from "../sync-plugin-key";

export type CursorUser = { name: string; color: string };
export type CursorPresenceState = {
  anchor?: Cursor;
  focus?: Cursor;
  user?: CursorUser;
};

export interface CursorPresenceStore {
  getAll(): Record<PeerID, CursorPresenceState>;
  getLocal(): CursorPresenceState | undefined;
  setLocal(state: CursorPresenceState): void;
  subscribe(listener: (by: "local" | "import" | "timeout") => void): () => void;
}

export interface CursorPluginOptions {
  getSelection?: (state: EditorState) => Selection;
  createCursor?: (user: PeerID) => Element;
  createSelection?: (user: PeerID) => DecorationAttrs;
  user?: CursorUser;
}

export const createCursorPlugin = (
  pluginKey: PluginKey<{ presenceUpdated: boolean }>,
  store: CursorPresenceStore,
  options: CursorPluginOptions,
): Plugin<DecorationSet> => {
  const getSelection = options.getSelection || ((state) => state.selection);
  const createSelection =
    options.createSelection ||
    ((user) => ({
      class: "loro-selection",
      "data-peer": user,
      style: `background-color: rgba(228, 208, 102, 0.5)`,
    }));
  const createCursor =
    options.createCursor ||
    ((user) => {
      const cursorUserData = store.getAll()[user];
      const cursor = document.createElement("span");
      cursor.classList.add("ProseMirror-loro-cursor");
      cursor.setAttribute(
        "style",
        `border-color: ${cursorUserData?.user?.color ?? user.slice(0, 6)}`,
      );
      const userDiv = document.createElement("div");
      userDiv.setAttribute(
        "style",
        `background-color: ${cursorUserData?.user?.color ?? user.slice(0, 6)}`,
      );
      userDiv.insertBefore(
        document.createTextNode(cursorUserData?.user?.name ?? user.slice(0, 6)),
        null,
      );
      const nonbreakingSpace1 = document.createTextNode("\u2060");
      const nonbreakingSpace2 = document.createTextNode("\u2060");
      cursor.insertBefore(nonbreakingSpace1, null);
      cursor.insertBefore(userDiv, null);
      cursor.insertBefore(nonbreakingSpace2, null);
      return cursor;
    });
  const plugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
    key: pluginKey,
    state: {
      init(_, state) {
        return createDecorations(
          state,
          store,
          plugin,
          createSelection,
          createCursor,
        );
      },
      apply(tr, prevState, _oldState, newState) {
        // Read the sync state from oldState as a fallback in case PM has
        // not yet populated newState's plugin field for the sync plugin
        // (this can happen if a host orders plugins by name/priority such
        // that the sync plugin runs *after* the cursor plugin during apply
        // — a real concern for Tiptap/BlockNote consumers).
        const loroState =
          loroSyncPluginKey.getState(newState) ??
          loroSyncPluginKey.getState(_oldState);
        const loroCursorState: { presenceUpdated: boolean } =
          tr.getMeta(pluginKey);
        if (
          (loroState && loroState.changedBy !== "local") ||
          (loroCursorState && loroCursorState.presenceUpdated)
        ) {
          return createDecorations(
            newState,
            store,
            plugin,
            createSelection,
            createCursor,
          );
        }

        return prevState.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations: (state) => {
        return plugin.getState(state);
      },
    },
    view: (view) => {
      const storeListener = (origin: "local" | "import" | "timeout") => {
        if (origin !== "local") {
          queueMicrotask(() => {
            if (view.isDestroyed) {
              return;
            }
            const tr = view.state.tr;
            tr.setMeta(pluginKey, {
              presenceUpdated: true,
            });
            tr.setMeta("addToHistory", false);
            view.dispatch(tr);
          });
        }
      };

      const updateCursorInfo = () => {
        if (view.isDestroyed) {
          return;
        }
        const loroState = loroSyncPluginKey.getState(view.state);
        const current = store.getLocal();
        if (loroState?.doc == null) {
          return;
        }

        const pmRootNode = view.state.doc;
        if (view.hasFocus()) {
          const selection = getSelection(view.state);
          let anchor: Cursor | undefined;
          let focus: Cursor | undefined;
          try {
            const encoded = convertPmSelectionToCursors(
              pmRootNode,
              selection,
              loroState,
            );
            anchor = encoded.anchor;
            focus = encoded.focus;
          } catch (e) {
            // Encoding failures (mapping miss, container races, etc.) must
            // not bubble up: if they reach view.dispatch they'd tear the
            // editor down on every keystroke. Skip this awareness update;
            // the next selection change will retry.
            loroState.onSyncEvent?.({
              kind: "error",
              phase: "cursor-encode",
              error: e,
            });
            console.warn(
              "[loro-prosemirror] cursor encode failed, skipping awareness update",
              e,
            );
            return;
          }
          if (
            current == null ||
            !cursorEq(current.anchor, anchor) ||
            !cursorEq(current.focus, focus)
          ) {
            store.setLocal({
              user: options.user ?? current?.user,
              anchor,
              focus,
            });
          }
        } else if (current?.focus != null) {
          // Lost focus — clear cursor presence but PRESERVE the user
          // metadata so name/color survive across blur/refocus cycles.
          store.setLocal({ user: options.user ?? current?.user });
        }
      };

      // Listen to presence store changes
      const unsubscribe = store.subscribe(storeListener);
      view.dom.addEventListener("focusin", updateCursorInfo);
      view.dom.addEventListener("focusout", updateCursorInfo);

      return {
        update: updateCursorInfo,
        destroy: () => {
          view.dom.removeEventListener("focusin", updateCursorInfo);
          view.dom.removeEventListener("focusout", updateCursorInfo);
          unsubscribe();
          store.setLocal({});
        },
      };
    },
  });

  return plugin;
};

function createDecorations(
  state: EditorState,
  store: CursorPresenceStore,
  _plugin: Plugin<DecorationSet>,
  createSelection: (user: PeerID) => DecorationAttrs,
  createCursor: (user: PeerID) => Element,
): DecorationSet {
  const all = store.getAll();
  const d: Decoration[] = [];
  const loroState = loroSyncPluginKey.getState(state);
  if (!loroState) {
    return DecorationSet.create(state.doc, []);
  }

  const doc = loroState.doc;
  const thisPeer = doc.peerIdStr;

  for (const [peer, cursor] of Object.entries(all)) {
    if (peer === thisPeer) {
      continue;
    }

    if (!cursor.anchor || !cursor.focus) {
      continue;
    }

    const [focus] = cursorToAbsolutePosition(
      cursor.focus,
      doc as LoroDocType,
      loroState.mapping,
    );
    if (focus == null) {
      // Decoding failed — peer's cursor anchored to a container we
      // can't resolve (typically a transient mapping miss right after
      // a remote insert). Surface via onSyncEvent for telemetry but
      // don't render anything for this peer this frame.
      loroState.onSyncEvent?.({
        kind: "error",
        phase: "cursor-decode",
        error: new Error(`failed to decode focus cursor for peer ${peer}`),
      });
      continue;
    }
    d.push(Decoration.widget(focus, createCursor(peer as PeerID)));
    if (!cursorEq(cursor.anchor, cursor.focus)) {
      const [anchor] = cursorToAbsolutePosition(
        cursor.anchor,
        doc as LoroDocType,
        loroState.mapping,
      );
      // The focus widget has already been pushed above. If the anchor
      // can't be decoded we still keep the caret visible for this peer
      // — we just skip the selection-range decoration.
      if (anchor == null) {
        loroState.onSyncEvent?.({
          kind: "error",
          phase: "cursor-decode",
          error: new Error(`failed to decode anchor cursor for peer ${peer}`),
        });
        continue;
      }
      d.push(
        Decoration.inline(
          Math.min(anchor, focus),
          Math.max(anchor, focus),
          createSelection(peer as PeerID),
        ),
      );
    }
  }

  return DecorationSet.create(state.doc, d);
}

export function convertPmSelectionToCursors(
  pmRootNode: Node,
  selection: Selection,
  loroState: LoroSyncPluginState,
) {
  const anchor = absolutePositionToCursor(
    pmRootNode,
    selection.anchor,
    loroState.doc as LoroDocType,
    loroState.mapping,
  );
  const focus =
    selection.head == selection.anchor
      ? anchor
      : absolutePositionToCursor(
          pmRootNode,
          selection.head,
          loroState.doc as LoroDocType,
          loroState.mapping,
        );
  return { anchor, focus };
}

function getByValue(map: Map<ContainerID, Node | Node[]>, searchValue: Node) {
  for (const [key, value] of map.entries()) {
    if (value === searchValue) return key;
  }
  return undefined;
}

function absolutePositionToCursor(
  pmRootNode: Node,
  anchor: number,
  doc: LoroDocType,
  mapping: LoroNodeMapping,
): Cursor | undefined {
  const pos = pmRootNode.resolve(anchor);
  const nodeParent = pos.node(pos.depth);
  const offset = pos.parentOffset;

  const loroId =
    WEAK_NODE_TO_LORO_CONTAINER_MAPPING.get(nodeParent) ??
    getByValue(mapping, nodeParent);
  if (!loroId) {
    // Selection sits on an unmapped node — most often a transient race
    // during init or right after a remote insert that hasn't been bound
    // yet. Returning undefined silently lets the next update retry; do
    // not log a console.error here (it would fire on every selection
    // change in those windows and pollute consumer logs).
    return undefined;
  }

  const loroMap: LoroNode = doc.getMap(loroId as never);
  const children = loroMap.get(CHILDREN_KEY);
  if (children.length == 0) {
    // This is a new line, so we can use the list cursor instead
    return children.getCursor(0);
  }

  let index = offset;
  let childIndex = 0;
  while (index >= 0 && childIndex < children.length) {
    const child = children.get(childIndex);
    childIndex += 1;
    if (child instanceof LoroText) {
      return child.getCursor(index);
    } else {
      if (index == 0) {
        // This happens when user selects an image or a horizontal rule
        if (childIndex < children.length) {
          // Select next text node
          index += 1;
        }
      }

      index -= 1;
    }
  }

  // Selection is not on text
  return undefined;
}

export function cursorToAbsolutePosition(
  cursor: Cursor,
  doc: LoroDocType,
  mapping: LoroNodeMapping,
): [number | null, Cursor | undefined] {
  const containerId = cursor.containerId();
  // Discriminate by the actual container type rather than by string-
  // sniffing the container ID — Loro's ID format is a stable but
  // implementation detail and `endsWith("List")` would silently
  // misroute if it ever changed.
  if (!isContainerId(containerId)) {
    return [null, undefined];
  }
  const container = doc.getContainerById(containerId);
  if (container == null) {
    return [null, undefined];
  }

  let index = -1;
  let targetChildId: ContainerID;
  let loroNode: LoroNode | undefined;
  let update: Cursor | undefined;
  if (container instanceof LoroList) {
    const parentNode = container.parent();
    if (!parentNode) {
      return [null, undefined];
    }
    targetChildId = parentNode.id;
    loroNode = parentNode.parent()?.parent() as LoroNode | undefined;
    index = 0;
  } else if (container instanceof LoroText) {
    const pos = doc.getCursorPos(cursor);
    if (!pos) {
      return [null, undefined];
    }
    update = pos.update;
    index += pos.offset;
    targetChildId = container.id;
    loroNode = container.parent()?.parent() as LoroNode | undefined;
  } else {
    return [null, undefined];
  }

  while (loroNode != null) {
    const children = loroNode.get(CHILDREN_KEY);
    if (children instanceof LoroList) {
      const childIds = children.toArray() as LoroNode[];
      for (const iter of childIds) {
        if (iter.id === targetChildId) {
          break;
        }

        const mapped = mapping.get(iter.id);
        if (Array.isArray(mapped)) {
          mapped.forEach((child) => {
            index += child.nodeSize;
          });
        } else if (mapped != null) {
          index += mapped.nodeSize;
        }
        // If a sibling has no mapping entry we silently treat it as
        // size 0. This matches the behaviour for a freshly-emptied
        // LoroText whose mapping entry was pruned. The previous
        // implementation logged a console.error here on every cursor
        // movement that touched an unmapped sibling — extremely noisy
        // and not actionable.
      }

      targetChildId = loroNode.id;
      loroNode = loroNode.parent()?.parent() as LoroNode | undefined;
      index += 1;
    } else {
      // Unreachable in a well-formed Loro tree; bail rather than throw
      // so an unexpected shape does not propagate as a crash.
      return [null, update];
    }
  }

  return [index, update];
}

export function cursorEq(a?: Cursor | null, b?: Cursor | null) {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }

  const aPos = a.pos();
  const bPos = b.pos();
  return (
    aPos?.peer === bPos?.peer &&
    aPos?.counter === bPos?.counter &&
    a.containerId() === b.containerId()
  );
}
