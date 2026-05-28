import { Fragment, Node, Schema, Slice } from "prosemirror-model";
import { EditorState, Plugin, PluginKey, Selection, TextSelection } from "prosemirror-state";
import { Awareness, Cursor, EphemeralStore, LoroDoc, LoroList, LoroMap, LoroText, LoroTree, UndoManager, isContainer, isContainerId } from "loro-crdt";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { simpleDiff } from "lib0/diff";
import { equalityDeep } from "lib0/function";
import * as delta from "lib0/delta";

//#region src/lib.ts
const ROOT_DOC_KEY = "doc";
const ATTRIBUTES_KEY = "attributes";
const CHILDREN_KEY = "children";
const NODE_NAME_KEY = "nodeName";
/**
* Maps PM non-text nodes to their corresponding Loro Container IDs.
*/
const WEAK_NODE_TO_LORO_CONTAINER_MAPPING = /* @__PURE__ */ new WeakMap();
function updateLoroToPmState(doc, mapping, editorState, containerId) {
	const node = editorState.doc;
	const map = containerId ? doc.getContainerById(containerId) : doc.getMap(ROOT_DOC_KEY);
	let isInit = false;
	if (map.get("nodeName") == null) {
		isInit = true;
		map.set("nodeName", node.type.name);
	}
	try {
		updateLoroMap(map, node, mapping);
	} catch (e) {
		try {
			doc.commit({ origin: isInit ? "sys:init" : "loroSyncPlugin" });
		} catch {}
		throw e;
	}
	doc.commit({ origin: isInit ? "sys:init" : "loroSyncPlugin" });
}
function createNodeFromLoroObj(schema, obj, mapping, onError) {
	let retval = mapping.get(obj.id) ?? null;
	if (retval != null) return retval;
	if (obj instanceof LoroMap) {
		const attributes = getLoroMapAttributes(obj);
		const children = getLoroMapChildren(obj);
		if (attributes == null || children == null) return null;
		const nodeName = obj.get("nodeName");
		if (nodeName == null || typeof nodeName !== "string") {
			const err = /* @__PURE__ */ new Error("Invalid nodeName");
			onError?.(err);
			throw err;
		}
		const mappedChildren = children.toArray().flatMap((child) => createNodeFromLoroObj(schema, child, mapping, onError)).filter((n) => n !== null);
		try {
			retval = schema.node(nodeName, attributes.toJSON(), mappedChildren);
			WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(retval, obj.id);
		} catch (e) {
			if (onError != null) onError(e);
			else console.error(e);
		}
	} else if (obj instanceof LoroText) {
		retval = [];
		for (const delta of obj.toDelta()) {
			if (delta.insert == null) continue;
			try {
				const marks = [];
				for (const [markName, mark] of Object.entries(delta.attributes ?? {})) {
					const markAttrs = valueToAttrs$1(mark);
					marks.push(schema.mark(markName, markAttrs ?? void 0));
				}
				retval.push(schema.text(delta.insert, marks));
			} catch (e) {
				if (onError != null) onError(e);
				else console.error(e);
			}
		}
	} else
 /* v8 ignore next */
	throw new Error("Invalid LoroType");
	if (retval != null) {
		if (!Array.isArray(retval)) WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(retval, obj.id);
		mapping.set(obj.id, retval);
	} else mapping.delete(obj.id);
	return retval;
}
function createLoroChild(parentList, pos, nodeOrNodeList, mapping) {
	return Array.isArray(nodeOrNodeList) ? createLoroText(parentList, pos, nodeOrNodeList, mapping) : createLoroMap(parentList, pos, nodeOrNodeList, mapping);
}
function createLoroText(parentList, pos, nodes, mapping) {
	const obj = parentList.insertContainer(pos ?? parentList.length, new LoroText()).getAttached();
	const delta = nodes.map((node) => ({
		insert: node.text,
		attributes: nodeMarksToAttributes(node.marks)
	}));
	obj.applyDelta(delta);
	mapping.set(obj.id, nodes);
	return obj;
}
function updateLoroText(obj, nodes, mapping) {
	mapping.set(obj.id, nodes);
	let str = obj.toString();
	const attrs = {};
	for (const delta of obj.toDelta()) for (const key of Object.keys(delta.attributes ?? {})) attrs[key] = null;
	const content = nodes.map((p) => ({
		insert: p.text,
		attributes: Object.assign({}, attrs, nodeMarksToAttributes(p.marks))
	}));
	const { insert, remove, index } = simpleDiff(str, content.map((c) => c.insert).join(""));
	if (remove > 0) obj.delete(index, remove);
	if (insert.length) obj.insert(index, insert);
	obj.applyDelta(content.map((c) => ({
		retain: c.insert.length,
		attributes: c.attributes
	})));
}
function nodeMarksToAttributes(marks) {
	const pattrs = {};
	for (const mark of marks) pattrs[mark.type.name] = mark.attrs;
	return pattrs;
}
function valueToAttrs$1(value) {
	if (value != null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)) return value;
	return null;
}
function eqLoroTextNodes(obj, nodes) {
	const delta = obj.toDelta();
	return delta.length === nodes.length && delta.every((delta, i) => delta.insert === nodes[i].text && Object.keys(delta.attributes || {}).length === nodes[i].marks.length && nodes[i].marks.every((mark) => {
		const attrs = valueToAttrs$1((delta.attributes || {})[mark.type.name]);
		return attrs != null && eqAttrs(attrs, mark.attrs);
	}));
}
/**
* Whether the loro object is equal to the node.
*/
function eqLoroObjNode(obj, node) {
	if (obj instanceof LoroMap) {
		if (Array.isArray(node) || !eqNodeName(obj, node)) return false;
		const loroChildren = getLoroMapChildren(obj);
		const normalizedContent = normalizeNodeContent(node);
		return loroChildren.length === normalizedContent.length && eqAttrs(getLoroMapAttributes(obj).toJSON(), node.attrs) && normalizedContent.every((childNode, i) => eqLoroObjNode(loroChildren.get(i), childNode));
	}
	return obj instanceof LoroText && Array.isArray(node) && eqLoroTextNodes(obj, node);
}
function eqAttrs(attrs1, attrs2) {
	const keys = Object.keys(attrs1).filter((key) => attrs1[key] !== null);
	let eq = keys.length === Object.keys(attrs2).filter((key) => attrs2[key] !== null).length;
	for (let i = 0; eq && i < keys.length; i++) {
		const key = keys[i];
		const l = attrs1[key];
		const r = attrs2[key];
		eq = l === r || typeof l === "object" && l !== null && typeof r === "object" && r !== null && eqAttrs(l, r);
	}
	return eq;
}
function eqNodeName(obj, node) {
	return !Array.isArray(node) && obj.get("nodeName") === node.type.name;
}
/**
* Checks if two nodes (or arrays of nodes) are equal.
* - If both are the same object, returns true.
* - If both are single nodes, uses their .eq() method.
* - If both are arrays, checks that they have the same length and each corresponding node is equal.
*/
function eqMappedNode(mapped, node) {
	if (mapped === node) return true;
	if (!Array.isArray(mapped) && !Array.isArray(node) && node) return mapped?.eq(node) ?? false;
	if (Array.isArray(mapped) && Array.isArray(node)) {
		if (mapped.length !== node.length) return false;
		for (let i = 0; i < mapped.length; i++) if (!node[i].eq(mapped[i])) return false;
		return true;
	}
	return false;
}
function normalizeNodeContent(node) {
	const res = [];
	let textNodes = null;
	node.content.forEach((node, _offset, _i) => {
		if (node.isText) {
			if (textNodes == null) {
				textNodes = [];
				res.push(textNodes);
			}
			textNodes.push(node);
		} else {
			res.push(node);
			textNodes = null;
		}
	});
	return res;
}
function computeChildEqualityFactor(obj, node, mapping) {
	const loroChildren = getLoroMapChildren(obj);
	const loroChildLength = loroChildren.length;
	const nodeChildren = normalizeNodeContent(node);
	const nodeChildLength = nodeChildren.length;
	const minLength = Math.min(loroChildLength, nodeChildLength);
	let left = 0;
	let right = 0;
	let foundMappedChild = false;
	for (; left < minLength; left++) {
		const leftLoro = loroChildren.get(left);
		const leftNode = nodeChildren[left];
		if (eqMappedNode(leftLoro != null && isContainer(leftLoro) ? mapping.get(leftLoro.id) : void 0, leftNode)) foundMappedChild = true;
		else if (leftLoro == null || leftNode == null || !eqLoroObjNode(leftLoro, leftNode)) break;
	}
	for (; left + right < minLength; right++) {
		const rightLoro = loroChildren.get(loroChildLength - right - 1);
		const rightNode = nodeChildren[nodeChildLength - right - 1];
		if (eqMappedNode(rightLoro != null && isContainer(rightLoro) ? mapping.get(rightLoro.id) : void 0, rightNode)) foundMappedChild = true;
		else if (rightLoro == null || rightNode == null || !eqLoroObjNode(rightLoro, rightNode)) break;
	}
	return {
		factor: left + right,
		foundMappedChild
	};
}
function createLoroMap(parentList, pos, node, mapping) {
	const obj = parentList.insertContainer(pos ?? parentList.length, new LoroMap()).getAttached();
	obj.set("nodeName", node.type.name);
	const attrs = getLoroMapAttributes(obj);
	for (const [key, value] of Object.entries(node.attrs)) if (value !== null) attrs.set(key, value);
	const children = getLoroMapChildren(obj);
	normalizeNodeContent(node).forEach((child, _i) => createLoroChild(children, null, child, mapping));
	WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(node, obj.id);
	mapping.set(obj.id, node);
	return obj;
}
function updateLoroMap(obj, node, mapping) {
	mapping.set(obj.id, node);
	WEAK_NODE_TO_LORO_CONTAINER_MAPPING.set(node, obj.id);
	if (!eqNodeName(obj, node)) throw new Error("node name mismatch!");
	updateLoroMapAttributes(obj, node, mapping);
	updateLoroMapChildren(obj, node, mapping);
}
function getLoroMapAttributes(obj) {
	return obj.getOrCreateContainer(ATTRIBUTES_KEY, new LoroMap());
}
function updateLoroMapAttributes(obj, node, _mapping) {
	const attrs = getLoroMapAttributes(obj);
	const keys = new Set(attrs.keys());
	const pAttrs = node.attrs;
	for (const [key, value] of Object.entries(pAttrs)) {
		if (value !== null) {
			if (!equalityDeep(attrs.get(key), value)) attrs.set(key, value);
		} else attrs.delete(key);
		keys.delete(key);
	}
	for (const key of keys) attrs.delete(key);
}
function getLoroMapChildren(obj) {
	return obj.getOrCreateContainer(CHILDREN_KEY, new LoroList());
}
function updateLoroMapChildren(obj, node, mapping) {
	const loroChildren = getLoroMapChildren(obj);
	const loroChildLength = loroChildren.length;
	const nodeChildren = normalizeNodeContent(node);
	const nodeChildLength = nodeChildren.length;
	const minLength = Math.min(nodeChildLength, loroChildLength);
	let left = 0;
	let right = 0;
	for (; left < minLength; left++) {
		const leftLoro = loroChildren.get(left);
		const leftNode = nodeChildren[left];
		if (leftLoro == null || leftNode == null) break;
		if (isContainer(leftLoro) && mapping.get(leftLoro.id) !== leftNode) if (eqMappedNode(mapping.get(leftLoro.id), leftNode) || eqLoroObjNode(leftLoro, leftNode)) {
			if (!Array.isArray(leftNode)) updateLoroMap(leftLoro, leftNode, mapping);
		} else break;
	}
	for (; right + left < minLength; right++) {
		const rightLoro = loroChildren.get(loroChildLength - right - 1);
		const rightNode = nodeChildren[nodeChildLength - right - 1];
		if (rightLoro == null || rightNode == null) break;
		if (isContainer(rightLoro) && mapping.get(rightLoro.id) !== rightNode) if (eqMappedNode(mapping.get(rightLoro.id), rightNode) || eqLoroObjNode(rightLoro, rightNode)) {
			if (!Array.isArray(rightNode)) updateLoroMap(rightLoro, rightNode, mapping);
		} else break;
	}
	while (loroChildLength - left - right > 0 && nodeChildLength - left - right > 0) {
		const leftLoro = loroChildren.get(left);
		const leftNode = nodeChildren[left];
		const rightLoro = loroChildren.get(loroChildLength - right - 1);
		const rightNode = nodeChildren[nodeChildLength - right - 1];
		if (leftLoro instanceof LoroText && Array.isArray(leftNode)) {
			if (!eqLoroTextNodes(leftLoro, leftNode)) updateLoroText(leftLoro, leftNode, mapping);
			left += 1;
		} else {
			let updateLeft = leftLoro instanceof LoroMap && eqNodeName(leftLoro, leftNode);
			let updateRight = rightLoro instanceof LoroMap && eqNodeName(rightLoro, rightNode);
			if (updateLeft && updateRight) {
				const leftEquality = computeChildEqualityFactor(leftLoro, leftNode, mapping);
				const rightEquality = computeChildEqualityFactor(rightLoro, rightNode, mapping);
				if (leftEquality.foundMappedChild && !rightEquality.foundMappedChild) updateRight = false;
				else if (rightEquality.foundMappedChild && !leftEquality.foundMappedChild) updateLeft = false;
				else if (leftEquality.factor < rightEquality.factor) updateLeft = false;
				else updateRight = false;
			}
			if (updateLeft) {
				updateLoroMap(leftLoro, leftNode, mapping);
				left += 1;
			} else if (updateRight) {
				updateLoroMap(rightLoro, rightNode, mapping);
				right += 1;
			} else {
				const child = loroChildren.get(left);
				if (isContainer(child)) mapping.delete(child.id);
				loroChildren.delete(left, 1);
				createLoroChild(loroChildren, left, leftNode, mapping);
				left += 1;
			}
		}
	}
	const loroDelLength = loroChildLength - left - right;
	if (loroChildLength === 1 && nodeChildLength === 0 && loroChildren.get(0) instanceof LoroText) {
		const loroText = loroChildren.get(0);
		mapping.delete(loroText.id);
		loroText.delete(0, loroText.length);
	} else if (loroDelLength > 0) {
		loroChildren.toArray().slice(left, left + loroDelLength).filter(isContainer).forEach((type) => mapping.delete(type.id));
		loroChildren.delete(left, loroDelLength);
	}
	if (left + right < nodeChildLength) nodeChildren.slice(left, nodeChildLength - right).forEach((nodeChild, i) => createLoroChild(loroChildren, left + i, nodeChild, mapping));
}
function clearChangedNodes(doc, event, mapping) {
	for (const e of event.events) {
		const obj = doc.getContainerById(e.target);
		mapping.delete(obj.id);
		let parentObj = obj.parent();
		while (parentObj) {
			mapping.delete(parentObj.id);
			parentObj = parentObj.parent();
		}
	}
}
/**
* Set a text selection between the given anchor and head positions. This
* function will ignore out-of-bounds positions, and find a valid selection near
* the given positions. Re-resolves against `view.state.doc` at dispatch
* time so an asynchronously-scheduled call (e.g. via `queueMicrotask`)
* never operates on a stale doc.
*/
function safeSetSelection(view, anchor, head) {
	if (view.isDestroyed) return;
	const doc = view.state.doc;
	const docSize = doc.content.size;
	if (anchor < 0 || anchor > docSize || head != null && (head < 0 || head > docSize)) return;
	const $anchor = doc.resolve(anchor);
	const $head = head != null ? doc.resolve(head) : void 0;
	const selection = TextSelection.between($anchor, $head || $anchor);
	view.dispatch(view.state.tr.setSelection(selection));
}

//#endregion
//#region src/sync-plugin-key.ts
const loroSyncPluginKey = new PluginKey("loro-sync");
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
const LORO_SYNC_META = {
	DOC_CHANGED: "doc-changed",
	NON_LOCAL_UPDATES: "non-local-updates",
	UPDATE_STATE: "update-state"
};
/**
* Returns the loroSyncPlugin's meta on this transaction, or `null` if
* the transaction is not plugin-internal. Equivalent to
* `tr.getMeta(loroSyncPluginKey) as LoroSyncTransactionMeta | null`
* but lets consumers avoid importing the plugin key just for this.
*/
function getLoroSyncMeta(tr) {
	return tr.getMeta(loroSyncPluginKey) ?? null;
}
/**
* Convenience predicate: did the loroSyncPlugin originate this
* transaction? Hosts use this to skip echo passes (e.g. don't
* re-stamp block IDs on a remote-driven `non-local-updates` tx).
*/
function isLoroInternalTransaction(tr) {
	return getLoroSyncMeta(tr) != null;
}

//#endregion
//#region src/logger.ts
const LEVEL_ORDER = {
	silent: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4
};
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
function createConsoleLogger(level = "warn", prefix = "[loro-prosemirror]") {
	const enabled = LEVEL_ORDER[level] ?? LEVEL_ORDER.warn;
	const fmt = (msg, ctx) => ctx == null ? [`${prefix} ${msg}`] : [`${prefix} ${msg}`, ctx];
	return {
		error: enabled >= LEVEL_ORDER.error ? (msg, ctx) => console.error(...fmt(msg, ctx)) : noop,
		warn: enabled >= LEVEL_ORDER.warn ? (msg, ctx) => console.warn(...fmt(msg, ctx)) : noop,
		info: enabled >= LEVEL_ORDER.info ? (msg, ctx) => console.info(...fmt(msg, ctx)) : noop,
		debug: enabled >= LEVEL_ORDER.debug ? (msg, ctx) => console.debug(...fmt(msg, ctx)) : noop
	};
}
const noop = () => {};
/**
* No-op logger. Useful in tests where any console output would be
* noise, or in performance-sensitive paths where the logger is
* threaded but logging is unwanted.
*/
const silentLogger = {
	error: noop,
	warn: noop,
	info: noop,
	debug: noop
};
/**
* The fallback logger used when a plugin is constructed without a
* `logger` prop. Production-safe defaults: `error` and `warn` print
* via `console.*`; `info` and `debug` are silent.
*/
const defaultLogger = createConsoleLogger("warn");

//#endregion
//#region src/cursor/common.ts
const createCursorPlugin = (pluginKey, store, options) => {
	const getSelection = options.getSelection || ((state) => state.selection);
	const createSelection = options.createSelection || ((user) => ({
		class: "loro-selection",
		"data-peer": user,
		style: `background-color: rgba(228, 208, 102, 0.5)`
	}));
	const createCursor = options.createCursor || ((user) => {
		const cursorUserData = store.getAll()[user];
		const cursor = document.createElement("span");
		cursor.classList.add("ProseMirror-loro-cursor");
		cursor.setAttribute("style", `border-color: ${cursorUserData?.user?.color ?? user.slice(0, 6)}`);
		const userDiv = document.createElement("div");
		userDiv.setAttribute("style", `background-color: ${cursorUserData?.user?.color ?? user.slice(0, 6)}`);
		userDiv.insertBefore(document.createTextNode(cursorUserData?.user?.name ?? user.slice(0, 6)), null);
		const nonbreakingSpace1 = document.createTextNode("⁠");
		const nonbreakingSpace2 = document.createTextNode("⁠");
		cursor.insertBefore(nonbreakingSpace1, null);
		cursor.insertBefore(userDiv, null);
		cursor.insertBefore(nonbreakingSpace2, null);
		return cursor;
	});
	const plugin = new Plugin({
		key: pluginKey,
		state: {
			init(_, state) {
				return createDecorations(state, store, plugin, createSelection, createCursor);
			},
			apply(tr, prevState, _oldState, newState) {
				const loroState = loroSyncPluginKey.getState(newState) ?? loroSyncPluginKey.getState(_oldState);
				const loroCursorState = tr.getMeta(pluginKey);
				if (loroState && loroState.changedBy !== "local" || loroCursorState && loroCursorState.presenceUpdated) return createDecorations(newState, store, plugin, createSelection, createCursor);
				return prevState.map(tr.mapping, tr.doc);
			}
		},
		props: { decorations: (state) => {
			return plugin.getState(state);
		} },
		view: (view) => {
			const storeListener = (origin) => {
				if (origin !== "local") queueMicrotask(() => {
					if (view.isDestroyed) return;
					const tr = view.state.tr;
					tr.setMeta(pluginKey, { presenceUpdated: true });
					tr.setMeta("addToHistory", false);
					view.dispatch(tr);
				});
			};
			const updateCursorInfo = () => {
				if (view.isDestroyed) return;
				const loroState = loroSyncPluginKey.getState(view.state);
				const current = store.getLocal();
				if (loroState?.doc == null) return;
				const pmRootNode = view.state.doc;
				if (view.hasFocus()) {
					const selection = getSelection(view.state);
					let anchor;
					let focus;
					try {
						const encoded = convertPmSelectionToCursors(pmRootNode, selection, loroState);
						anchor = encoded.anchor;
						focus = encoded.focus;
					} catch (e) {
						loroState.onSyncEvent?.({
							kind: "error",
							phase: "cursor-encode",
							error: e
						});
						(loroState.logger ?? defaultLogger).warn("cursor encode failed, skipping awareness update", { error: e });
						return;
					}
					if (current == null || !cursorEq(current.anchor, anchor) || !cursorEq(current.focus, focus)) store.setLocal({
						user: options.user ?? current?.user,
						anchor,
						focus
					});
				} else if (current?.focus != null) store.setLocal({ user: options.user ?? current?.user });
			};
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
				}
			};
		}
	});
	return plugin;
};
function createDecorations(state, store, _plugin, createSelection, createCursor) {
	const all = store.getAll();
	const d = [];
	const loroState = loroSyncPluginKey.getState(state);
	if (!loroState) return DecorationSet.create(state.doc, []);
	const doc = loroState.doc;
	const thisPeer = doc.peerIdStr;
	for (const [peer, cursor] of Object.entries(all)) {
		if (peer === thisPeer) continue;
		if (!cursor.anchor || !cursor.focus) continue;
		const [focus] = cursorToAbsolutePosition(cursor.focus, doc, loroState.mapping);
		if (focus == null) {
			loroState.onSyncEvent?.({
				kind: "error",
				phase: "cursor-decode",
				error: /* @__PURE__ */ new Error(`failed to decode focus cursor for peer ${peer}`)
			});
			continue;
		}
		d.push(Decoration.widget(focus, createCursor(peer)));
		if (!cursorEq(cursor.anchor, cursor.focus)) {
			const [anchor] = cursorToAbsolutePosition(cursor.anchor, doc, loroState.mapping);
			if (anchor == null) {
				loroState.onSyncEvent?.({
					kind: "error",
					phase: "cursor-decode",
					error: /* @__PURE__ */ new Error(`failed to decode anchor cursor for peer ${peer}`)
				});
				continue;
			}
			d.push(Decoration.inline(Math.min(anchor, focus), Math.max(anchor, focus), createSelection(peer)));
		}
	}
	return DecorationSet.create(state.doc, d);
}
function convertPmSelectionToCursors(pmRootNode, selection, loroState) {
	const anchor = absolutePositionToCursor(pmRootNode, selection.anchor, loroState.doc, loroState.mapping);
	return {
		anchor,
		focus: selection.head == selection.anchor ? anchor : absolutePositionToCursor(pmRootNode, selection.head, loroState.doc, loroState.mapping)
	};
}
function getByValue(map, searchValue) {
	for (const [key, value] of map.entries()) if (value === searchValue) return key;
}
function absolutePositionToCursor(pmRootNode, anchor, doc, mapping) {
	const pos = pmRootNode.resolve(anchor);
	const nodeParent = pos.node(pos.depth);
	const offset = pos.parentOffset;
	const loroId = WEAK_NODE_TO_LORO_CONTAINER_MAPPING.get(nodeParent) ?? getByValue(mapping, nodeParent);
	if (!loroId) return;
	const children = doc.getMap(loroId).get(CHILDREN_KEY);
	if (children.length == 0) return children.getCursor(0);
	let index = offset;
	let childIndex = 0;
	while (index >= 0 && childIndex < children.length) {
		const child = children.get(childIndex);
		childIndex += 1;
		if (child instanceof LoroText) {
			const textLen = child.length;
			if (index < textLen) return child.getCursor(index);
			index -= textLen;
		} else {
			if (index == 0) {
				if (childIndex < children.length) index += 1;
			}
			index -= 1;
		}
	}
}
function cursorToAbsolutePosition(cursor, doc, mapping) {
	const containerId = cursor.containerId();
	if (!isContainerId(containerId)) return [null, void 0];
	const container = doc.getContainerById(containerId);
	if (container == null) return [null, void 0];
	let index = -1;
	let targetChildId;
	let loroNode;
	let update;
	if (container instanceof LoroList) {
		const parentNode = container.parent();
		if (!parentNode) return [null, void 0];
		targetChildId = parentNode.id;
		loroNode = parentNode.parent()?.parent();
		index = 0;
	} else if (container instanceof LoroText) {
		const pos = doc.getCursorPos(cursor);
		if (!pos) return [null, void 0];
		update = pos.update;
		index += pos.offset;
		targetChildId = container.id;
		loroNode = container.parent()?.parent();
	} else return [null, void 0];
	while (loroNode != null) {
		const children = loroNode.get(CHILDREN_KEY);
		if (children instanceof LoroList) {
			const childIds = children.toArray();
			for (const iter of childIds) {
				if (iter.id === targetChildId) break;
				const mapped = mapping.get(iter.id);
				if (Array.isArray(mapped)) mapped.forEach((child) => {
					index += child.nodeSize;
				});
				else if (mapped != null) index += mapped.nodeSize;
			}
			targetChildId = loroNode.id;
			loroNode = loroNode.parent()?.parent();
			index += 1;
		} else return [null, update];
	}
	return [index, update];
}
function cursorEq(a, b) {
	if (!a && !b) return true;
	if (!a || !b) return false;
	const aPos = a.pos();
	const bPos = b.pos();
	return aPos?.peer === bPos?.peer && aPos?.counter === bPos?.counter && a.containerId() === b.containerId();
}

//#endregion
//#region src/incremental-sync.ts
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
function findContainerLocation(doc, containerId, mapping, cache) {
	if (doc == null || containerId == null || mapping == null) return null;
	if (cache != null) {
		const cached = cache.get(containerId);
		if (cached !== void 0) return cached;
	}
	const result = findContainerLocationUncached(doc, containerId, mapping);
	if (cache != null) cache.set(containerId, result);
	return result;
}
function findContainerLocationUncached(doc, containerId, mapping) {
	const mapped = mapping.get(containerId);
	if (mapped == null) return null;
	if (Array.isArray(mapped)) {
		if (mapped.length === 0) return null;
		const firstText = mapped[0];
		let runStart = null;
		doc.descendants((node, pos) => {
			if (runStart != null) return false;
			let offset = 0;
			for (let i = 0; i < node.childCount; i++) {
				const child = node.child(i);
				if (child === firstText) {
					runStart = pos + 1 + offset;
					return false;
				}
				offset += child.nodeSize;
			}
			return true;
		});
		if (runStart == null) {
			console.warn("[loro-pm] findContainerLocation: text node not found in doc", {
				containerId,
				mappedLength: mapped.length
			});
			return null;
		}
		return {
			node: mapped,
			pos: runStart,
			isText: true
		};
	}
	if (mapped === doc) return {
		node: mapped,
		pos: 0,
		isText: false
	};
	let foundPos = null;
	doc.descendants((node, pos) => {
		if (foundPos != null) return false;
		if (node === mapped) {
			foundPos = pos;
			return false;
		}
		return true;
	});
	if (foundPos == null) doc.descendants((node, pos) => {
		if (foundPos != null) return false;
		if (WEAK_NODE_TO_LORO_CONTAINER_MAPPING.get(node) === containerId) {
			foundPos = pos;
			mapping.set(containerId, node);
			return false;
		}
		return true;
	});
	if (foundPos == null) return null;
	return {
		node: mapped,
		pos: foundPos,
		isText: false
	};
}
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
function findEmptyTextPosition(pmDoc, textId, mapping, loroDoc) {
	if (pmDoc == null || textId == null || mapping == null || loroDoc == null) return null;
	const text = loroDoc.getContainerById(textId);
	if (!(text instanceof LoroText)) return null;
	const parentList = text.parent();
	if (!(parentList instanceof LoroList)) return null;
	const parentBlock = parentList.parent();
	if (!(parentBlock instanceof LoroMap)) return null;
	const blockLoc = findContainerLocation(pmDoc, parentBlock.id, mapping);
	if (blockLoc == null || blockLoc.isText || Array.isArray(blockLoc.node)) return null;
	let textIdx = -1;
	for (let i = 0; i < parentList.length; i++) {
		const sibling = parentList.get(i);
		if (isContainer(sibling) && sibling.id === textId) {
			textIdx = i;
			break;
		}
	}
	if (textIdx === -1) return null;
	let offset = 0;
	for (let i = 0; i < textIdx; i++) {
		const sibling = parentList.get(i);
		if (!isContainer(sibling)) return null;
		const siblingMapped = mapping.get(sibling.id);
		if (siblingMapped == null) continue;
		if (Array.isArray(siblingMapped)) for (const n of siblingMapped) offset += n.nodeSize;
		else offset += siblingMapped.nodeSize;
	}
	return (blockLoc.node === pmDoc ? blockLoc.pos : blockLoc.pos + 1) + offset;
}
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
function loroEventBatchToTransaction(state, batch, mapping, doc) {
	if (batch == null || batch.events == null) return null;
	if (batch.by === "checkout") return null;
	if (batch.events.length === 0) return state.tr;
	const tr = state.tr;
	const materialisedInBatch = /* @__PURE__ */ new Set();
	const parentTouchedInBatch = /* @__PURE__ */ new Set();
	const dirtyAncestorBlocks = /* @__PURE__ */ new Set();
	const locationCache = /* @__PURE__ */ new Map();
	for (const event of batch.events) {
		if (materialisedInBatch.has(event.target)) continue;
		if (!applyEvent(tr, state, event, mapping, doc, materialisedInBatch, parentTouchedInBatch, dirtyAncestorBlocks, locationCache)) return null;
	}
	return tr;
}
/**
* Walk up from `target` and add every ancestor block (LoroMap with a
* `nodeName`) ID to `set`. Used to mark "this block's subtree has had
* a mutation" so subsequent list events on the block bail to fallback
* (their pre-state child widths would be stale).
*/
function markAncestorsDirty(doc, target, set) {
	const c = doc.getContainerById(target);
	if (c == null) return;
	let p = c.parent();
	while (p != null) {
		if (p instanceof LoroMap && p.get(NODE_NAME_KEY) != null) set.add(p.id);
		if (p instanceof LoroMap || p instanceof LoroList || p instanceof LoroText) p = p.parent();
		else break;
	}
}
function applyEvent(tr, state, event, mapping, doc, materialisedInBatch, parentTouchedInBatch, dirtyAncestorBlocks, locationCache) {
	switch (event.diff.type) {
		case "text": return applyTextDiff(tr, state, event.target, event.diff, mapping, doc, parentTouchedInBatch, dirtyAncestorBlocks, locationCache);
		case "list": return applyListDiff(tr, state, event.target, event.diff, mapping, doc, materialisedInBatch, parentTouchedInBatch, dirtyAncestorBlocks, locationCache);
		case "map": return applyMapDiff(tr, state, event.target, event.diff, mapping, doc, dirtyAncestorBlocks, locationCache);
		default: return false;
	}
}
function applyTextDiff(tr, state, target, diff, mapping, doc, parentTouchedInBatch, dirtyAncestorBlocks, locationCache) {
	const loc = findContainerLocation(state.doc, target, mapping, locationCache);
	let prePos;
	let usedFallback = false;
	if (loc != null && loc.isText) prePos = loc.pos;
	else if (loc == null) {
		const text = doc.getContainerById(target);
		if (!(text instanceof LoroText)) return false;
		if (anyAncestorTouched(text, parentTouchedInBatch)) return false;
		const fallback = findEmptyTextPosition(state.doc, target, mapping, doc);
		if (fallback == null) return false;
		prePos = fallback;
		usedFallback = true;
	} else return false;
	let cursor = tr.mapping.map(prePos);
	for (const op of diff.diff) if (op.retain != null) {
		if (usedFallback && op.retain > 0) return false;
		if (op.attributes && op.retain > 0) {
			if (!applyMarkAttributes(tr, state.schema, cursor, cursor + op.retain, op.attributes)) return false;
		}
		cursor += op.retain;
	} else if (op.insert != null) {
		const marks = op.attributes ? attributesToMarks(state.schema, op.attributes) : [];
		if (marks === null) return false;
		const textNode = state.schema.text(op.insert, marks);
		tr.insert(cursor, textNode);
		cursor += op.insert.length;
	} else if (op.delete != null) {
		if (usedFallback) return false;
		tr.delete(cursor, cursor + op.delete);
	} else return false;
	markAncestorsDirty(doc, target, dirtyAncestorBlocks);
	return true;
}
/**
* Returns true if any ancestor of the given Loro container has been
* recorded in `parentTouchedInBatch` (the set of block IDs whose
* children list was mutated earlier in this batch). The empty-text
* fallback walks the parent block's pre-batch children to compute a
* PM position; an insert/delete in any ancestor breaks that
* invariant.
*/
function anyAncestorTouched(container, parentTouchedInBatch) {
	let node = container?.parent();
	while (node != null) {
		if (node instanceof LoroMap && parentTouchedInBatch.has(node.id)) return true;
		if (node instanceof LoroMap || node instanceof LoroList || node instanceof LoroText) node = node.parent();
		else break;
	}
	return false;
}
/**
* Convert a Loro text-attribute map to PM marks. Used when a delta op's
* `insert` carries inline marks. Returns `null` if the schema does not
* contain a referenced mark (caller bails to fallback).
*/
function attributesToMarks(schema, attributes) {
	const marks = [];
	for (const [name, raw] of Object.entries(attributes)) {
		if (raw == null) continue;
		const markType = schema.marks[name];
		if (markType == null) return null;
		const attrs = valueToAttrs(raw);
		marks.push(markType.create(attrs ?? void 0));
	}
	return marks;
}
/**
* Apply a mark-attribute change over `[from, to)`.
*/
function applyMarkAttributes(tr, schema, from, to, attributes) {
	for (const [name, raw] of Object.entries(attributes)) {
		const markType = schema.marks[name];
		if (markType == null) return false;
		if (raw == null) tr.removeMark(from, to, markType);
		else {
			const attrs = valueToAttrs(raw);
			tr.addMark(from, to, markType.create(attrs ?? void 0));
		}
	}
	return true;
}
function applyListDiff(tr, state, target, diff, mapping, doc, materialisedInBatch, parentTouchedInBatch, dirtyAncestorBlocks, locationCache) {
	const loroList = doc.getContainerById(target);
	if (!(loroList instanceof LoroList)) return false;
	const parentMap = loroList.parent();
	if (!(parentMap instanceof LoroMap)) return false;
	if (parentMap.get(NODE_NAME_KEY) == null) return false;
	if (parentTouchedInBatch.has(parentMap.id)) return false;
	if (dirtyAncestorBlocks.has(parentMap.id)) return false;
	const parentLoc = findContainerLocation(state.doc, parentMap.id, mapping, locationCache);
	if (parentLoc == null || parentLoc.isText) return false;
	const parentNode = parentLoc.node;
	const parentPos = tr.mapping.map(parentLoc.pos);
	const contentStart = parentNode === state.doc ? parentPos : parentPos + 1;
	const items = snapshotChildren(parentNode);
	let listIdx = 0;
	let pmCursor = 0;
	let listChanged = false;
	for (const op of diff.diff) if (op.retain != null) for (let i = 0; i < op.retain; i++) {
		if (listIdx >= items.length) return false;
		pmCursor += items[listIdx].pmEnd - items[listIdx].pmStart;
		listIdx++;
	}
	else if (op.delete != null) {
		let removedSize = 0;
		const subtreesToPrune = [];
		for (let i = 0; i < op.delete; i++) {
			if (listIdx >= items.length) return false;
			const item = items[listIdx];
			removedSize += item.pmEnd - item.pmStart;
			subtreesToPrune.push(item.pmNode);
			listIdx++;
		}
		if (removedSize > 0) {
			tr.delete(contentStart + pmCursor, contentStart + pmCursor + removedSize);
			for (const subtree of subtreesToPrune) pruneSubtreeFromMapping(subtree, mapping, locationCache);
			listChanged = true;
		}
	} else if (op.insert != null) {
		const inserted = op.insert;
		const scratchMapping = new Map(mapping);
		const fragments = [];
		const newlyMaterialised = [];
		for (const value of inserted) {
			if (!isContainer(value)) return false;
			const node = materializeInsertedContainer(state.schema, value, scratchMapping);
			if (node == null) return false;
			newlyMaterialised.push(value);
			if (Array.isArray(node)) for (const n of node) fragments.push(n);
			else fragments.push(node);
		}
		const fragment = Fragment.from(fragments);
		const insertPos = contentStart + pmCursor;
		let $pos;
		try {
			$pos = tr.doc.resolve(insertPos);
		} catch {
			return false;
		}
		if (!$pos.parent.canReplace($pos.index(), $pos.index(), fragment)) return false;
		tr.insert(insertPos, fragment);
		for (const [k, v] of scratchMapping) mapping.set(k, v);
		for (const container of newlyMaterialised) collectContainerIds(container, materialisedInBatch);
		pmCursor += fragment.size;
		listChanged = true;
	} else return false;
	if (listChanged) {
		parentTouchedInBatch.add(parentMap.id);
		markAncestorsDirty(doc, target, dirtyAncestorBlocks);
	}
	return true;
}
/**
* Walk a parent block's pre-state PM children and turn them into a flat
* array aligned 1:1 with the Loro children list. Consecutive PM text
* nodes that share a single `LoroText` are coalesced into one entry.
*/
function snapshotChildren(parent) {
	const items = [];
	let offset = 0;
	let i = 0;
	while (i < parent.childCount) {
		const child = parent.child(i);
		if (child.isText) {
			const runStart = offset;
			const run = [];
			while (i < parent.childCount && parent.child(i).isText) {
				run.push(parent.child(i));
				offset += parent.child(i).nodeSize;
				i++;
			}
			items.push({
				pmNode: run,
				pmStart: runStart,
				pmEnd: offset
			});
		} else {
			items.push({
				pmNode: child,
				pmStart: offset,
				pmEnd: offset + child.nodeSize
			});
			offset += child.nodeSize;
			i++;
		}
	}
	return items;
}
/**
* Recursively remove `mapping` entries for every Loro container bound to
* a deleted PM subtree. Also invalidates `locationCache` entries for
* the pruned IDs so a later event in the same batch cannot read a
* stale location for a deleted container.
*
* For block PM Nodes we look up the ContainerID in the
* `WEAK_NODE_TO_LORO_CONTAINER_MAPPING` reverse index and prune by id
* (and recurse into block children). For text runs we scan `mapping`
* for the entry whose value is the array of text nodes — O(n) per run
* but only triggered on delete.
*/
function pruneSubtreeFromMapping(pmNode, mapping, locationCache) {
	if (Array.isArray(pmNode)) {
		if (pmNode.length === 0) return;
		const cid = findContainerIdForTextRun(mapping, pmNode);
		if (cid != null) {
			mapping.delete(cid);
			locationCache?.delete(cid);
		}
		return;
	}
	const cid = WEAK_NODE_TO_LORO_CONTAINER_MAPPING.get(pmNode) ?? findBlockContainerId(mapping, pmNode);
	if (cid != null) {
		mapping.delete(cid);
		locationCache?.delete(cid);
	}
	let i = 0;
	while (i < pmNode.childCount) {
		const child = pmNode.child(i);
		if (child.isText) {
			const run = [];
			while (i < pmNode.childCount && pmNode.child(i).isText) {
				run.push(pmNode.child(i));
				i++;
			}
			pruneSubtreeFromMapping(run, mapping, locationCache);
		} else {
			pruneSubtreeFromMapping(child, mapping, locationCache);
			i++;
		}
	}
}
function findContainerIdForTextRun(mapping, run) {
	const first = run[0];
	for (const [id, value] of mapping) if (Array.isArray(value) && value.includes(first)) return id;
	return null;
}
function findBlockContainerId(mapping, block) {
	for (const [id, value] of mapping) if (value === block) return id;
	return null;
}
/**
* Recursively collect every container ID inside a freshly-inserted
* subtree, so that later events targeting any of them in the same batch
* are skipped.
*/
function collectContainerIds(container, set) {
	set.add(container.id);
	if (container instanceof LoroMap) for (const key of container.keys()) {
		const value = container.get(key);
		if (isContainer(value)) collectContainerIds(value, set);
	}
	else if (container instanceof LoroList) for (let i = 0; i < container.length; i++) {
		const value = container.get(i);
		if (isContainer(value)) collectContainerIds(value, set);
	}
}
/**
* Materialise a container that was just inserted into Loro into a PM
* Node (or array of inline text nodes for `LoroText`), populating the
* mapping with fresh bindings for it and any nested containers.
*
* Returns `null` for container types this binding does not support
* (e.g. `LoroTree`); the caller bails to fallback.
*/
function materializeInsertedContainer(schema, container, mapping) {
	if (container instanceof LoroMap) return createNodeFromLoroObj(schema, container, mapping);
	if (container instanceof LoroText) return createNodeFromLoroObj(schema, container, mapping);
	return null;
}
function applyMapDiff(tr, state, target, diff, mapping, doc, dirtyAncestorBlocks, locationCache) {
	const container = doc.getContainerById(target);
	if (!(container instanceof LoroMap)) return false;
	const parent = container.parent();
	if (!(parent instanceof LoroMap)) return false;
	if (parent.get(NODE_NAME_KEY) == null) return false;
	const attrsContainer = parent.get(ATTRIBUTES_KEY);
	if (!(attrsContainer instanceof LoroMap) || attrsContainer.id !== target) return false;
	if (dirtyAncestorBlocks.has(parent.id)) return false;
	const blockLoc = findContainerLocation(state.doc, parent.id, mapping, locationCache);
	if (blockLoc == null || blockLoc.isText || Array.isArray(blockLoc.node)) return false;
	const blockNode = blockLoc.node;
	const blockPos = tr.mapping.map(blockLoc.pos);
	const newAttrs = { ...blockNode.attrs };
	for (const [key, raw] of Object.entries(diff.updated)) if (raw === void 0 || raw === null) delete newAttrs[key];
	else if (isContainer(raw)) return false;
	else newAttrs[key] = raw;
	try {
		tr.setNodeMarkup(blockPos, void 0, newAttrs);
	} catch {
		return false;
	}
	markAncestorsDirty(doc, target, dirtyAncestorBlocks);
	return true;
}
function valueToAttrs(value) {
	if (value != null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)) return value;
	return null;
}

//#endregion
//#region src/text-style.ts
const LORO_TEXT_STYLE_CACHE = /* @__PURE__ */ new WeakMap();
function getLoroTextStyle(schema) {
	return Object.fromEntries(Object.entries(schema.marks).map(([markName, markType]) => [markName, { expand: markType.spec.inclusive ? "after" : "none" }]));
}
function configLoroTextStyle(doc, schema) {
	let schemaSet = LORO_TEXT_STYLE_CACHE.get(doc);
	if (schemaSet == null) {
		schemaSet = /* @__PURE__ */ new WeakSet();
		LORO_TEXT_STYLE_CACHE.set(doc, schemaSet);
	}
	if (schemaSet.has(schema)) return;
	schemaSet.add(schema);
	doc.configTextStyle(getLoroTextStyle(schema));
}

//#endregion
//#region src/undo-plugin-key.ts
const loroUndoPluginKey = new PluginKey("loro-undo");

//#endregion
//#region src/sync-plugin.ts
const LoroSyncPlugin = (props) => {
	return new Plugin({
		key: loroSyncPluginKey,
		props: { editable: (state) => {
			return loroSyncPluginKey.getState(state)?.snapshot == null;
		} },
		state: {
			init: (_config, editorState) => {
				configLoroTextStyle(props.doc, editorState.schema);
				return {
					doc: props.doc,
					mapping: props.mapping ?? /* @__PURE__ */ new Map(),
					changedBy: "local",
					containerId: props.containerId,
					onSyncEvent: props.onSyncEvent,
					disableFallbackCursorRestore: props.disableFallbackCursorRestore,
					logger: props.logger ?? defaultLogger
				};
			},
			apply: (tr, state, oldEditorState, newEditorState) => {
				const meta = tr.getMeta(loroSyncPluginKey);
				const undoState = loroUndoPluginKey.getState(oldEditorState);
				switch (meta?.type) {
					case "non-local-updates": return state.changedBy === meta.changedBy ? state : {
						...state,
						changedBy: meta.changedBy
					};
					case "doc-changed":
						if (!undoState?.isUndoing.current) try {
							updateLoroToPmState(state.doc, state.mapping, newEditorState, state.containerId);
							getLogger(state).debug("doc-changed: PM->Loro write");
						} catch (e) {
							emitSyncEvent(state, {
								kind: "error",
								phase: "doc-changed",
								error: e
							});
							getLogger(state).error("updateLoroToPmState threw, doc may diverge until next event", { error: e });
						}
						return state.changedBy === "local" ? state : {
							...state,
							changedBy: "local"
						};
					case "update-state": {
						const next = {
							...state,
							...meta.state
						};
						if (meta.commitInit) try {
							next.doc.commit({
								origin: "sys:init",
								timestamp: Date.now()
							});
						} catch (e) {
							emitSyncEvent(next, {
								kind: "error",
								phase: "update-state",
								error: e
							});
							getLogger(next).error("sys:init commit threw", { error: e });
						}
						return next;
					}
					default: return state;
				}
			}
		},
		appendTransaction: (transactions, _oldEditorState, newEditorState) => {
			if (transactions.some((tr) => tr.getMeta(loroSyncPluginKey) != null)) return null;
			if (transactions.some((tr) => tr.docChanged)) return newEditorState.tr.setMeta(loroSyncPluginKey, { type: "doc-changed" });
			return null;
		},
		view: (view) => {
			let unsubscribe = null;
			try {
				unsubscribe = init(view, props);
			} catch (e) {
				const state = loroSyncPluginKey.getState(view.state);
				if (state != null) emitSyncEvent(state, {
					kind: "error",
					phase: "init",
					error: e
				});
				(state?.logger ?? defaultLogger).error("init threw, editor mounted unsynced", { error: e });
			}
			return {
				update: (_view, _prevState) => {},
				destroy: () => {
					unsubscribe?.();
					unsubscribe = null;
				}
			};
		}
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
function init(view, props) {
	if (view.isDestroyed) return () => {};
	const state = loroSyncPluginKey.getState(view.state);
	if (state == null) throw new Error("[loro-prosemirror] LoroSyncPlugin state was not initialised before view() ran");
	let docSubscription;
	if (state.containerId) {
		const container = state.doc.getContainerById(state.containerId);
		if (container == null) throw new Error(`[loro-prosemirror] containerId ${String(state.containerId)} not found in Loro doc`);
		docSubscription = container.subscribe((event) => {
			updateNodeOnLoroEvent(view, event);
		});
	} else docSubscription = state.doc.subscribe((event) => updateNodeOnLoroEvent(view, event));
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
function bootstrapDispatch(view, state, docSubscription) {
	const innerDoc = state.containerId ? state.doc.getContainerById(state.containerId) : state.doc.getMap(ROOT_DOC_KEY);
	const mapping = /* @__PURE__ */ new Map();
	const pmIsEmpty = isPmDocEmpty(view.state.doc);
	if (innerDoc.size === 0 && pmIsEmpty) {
		const tr = view.state.tr;
		tr.setMeta(loroSyncPluginKey, {
			type: "update-state",
			state: {
				mapping,
				docSubscription,
				snapshot: null
			},
			commitInit: false
		});
		tr.setMeta("addToHistory", false);
		view.dispatch(tr);
		emitSyncEvent(state, {
			kind: "init",
			mode: "both-empty"
		});
		return;
	}
	if (innerDoc.size === 0 && !pmIsEmpty) {
		updateLoroToPmState(state.doc, mapping, view.state, state.containerId);
		const tr = view.state.tr;
		tr.setMeta(loroSyncPluginKey, {
			type: "update-state",
			state: {
				mapping,
				docSubscription,
				snapshot: null
			},
			commitInit: false
		});
		tr.setMeta("addToHistory", false);
		view.dispatch(tr);
		emitSyncEvent(state, {
			kind: "init",
			mode: "pm-seeded"
		});
		return;
	}
	const schema = view.state.schema;
	const node = createNodeFromLoroObj(schema, innerDoc, mapping, (e) => emitSyncEvent(state, {
		kind: "error",
		phase: "materialize",
		error: e
	}));
	if (node == null) throw new Error("[loro-prosemirror] createNodeFromLoroObj returned null for the root container");
	const tr = view.state.tr.replace(0, view.state.doc.content.size, new Slice(Fragment.from(node), 0, 0));
	tr.setMeta(loroSyncPluginKey, {
		type: "update-state",
		state: {
			mapping,
			docSubscription,
			snapshot: null
		},
		commitInit: true
	});
	tr.setMeta("addToHistory", false);
	view.dispatch(tr);
	fixRootMapping(state, mapping, view);
	emitSyncEvent(state, {
		kind: "init",
		mode: "loro-populated"
	});
}
/**
* Heuristic for "the host did not put any user content in PM yet". A
* fresh `EditorState.create({schema, plugins})` produces a doc whose
* `content.size` is zero (the doc node itself contributes opening/
* closing tokens but those are outside `content.size`). We rely on
* that to decide whether case 1 or case 2 applies.
*/
function isPmDocEmpty(doc) {
	return doc.content.size === 0;
}
function updateNodeOnLoroEvent(view, event) {
	if (view.isDestroyed) return;
	const state = loroSyncPluginKey.getState(view.state);
	if (state == null) return;
	if (event.by === "local" && event.origin !== "undo") {
		getLogger(state).debug("skip own local non-undo event", {
			origin: event.origin,
			eventCount: event.events.length
		});
		return;
	}
	getLogger(state).debug("processing Loro event batch", {
		by: event.by,
		origin: event.origin,
		eventCount: event.events.length
	});
	const { tr: incrementalTr, threw } = tryIncrementalSync(view, event, state);
	if (incrementalTr != null) {
		incrementalTr.setMeta(loroSyncPluginKey, {
			type: "non-local-updates",
			changedBy: event.by
		});
		incrementalTr.setMeta("addToHistory", false);
		view.dispatch(incrementalTr);
		emitSyncEvent(state, {
			kind: "incremental",
			eventCount: event.events.length,
			by: event.by,
			origin: event.origin
		});
		return;
	}
	emitSyncEvent(state, {
		kind: "fallback",
		reason: threw ? "translator-threw" : event.by === "checkout" ? "checkout" : "translator-null",
		eventCount: event.events.length,
		by: event.by,
		origin: event.origin
	});
	fullReplaceFallback(view, event, state);
}
/**
* Resolve the logger for a given plugin state. Falls back to the
* default console logger if the state predates the logger field
* (defensive — should never fire in practice).
*/
function getLogger(state) {
	return state.logger ?? defaultLogger;
}
/**
* Notify the consumer's `onSyncEvent` hook, if any. A throwing hook is
* never allowed to break the dispatch flow.
*/
function emitSyncEvent(state, info) {
	const hook = state.onSyncEvent;
	if (hook == null) return;
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
function tryIncrementalSync(view, event, state) {
	try {
		return {
			tr: loroEventBatchToTransaction(view.state, event, state.mapping, state.doc),
			threw: false
		};
	} catch (e) {
		getLogger(state).error("incremental sync threw, falling back to full replace", {
			error: e,
			batchBy: event.by,
			batchOrigin: event.origin,
			eventCount: event.events.length,
			firstTarget: event.events[0]?.target,
			firstDiffType: event.events[0]?.diff.type
		});
		return {
			tr: null,
			threw: true
		};
	}
}
/**
* Walk the actual PM doc and update mapping entries to point to the real
* post-dispatch nodes. Uses WEAK_NODE_TO_LORO_CONTAINER_MAPPING as the
* reverse index (ContainerID is stored on each node by createNodeFromLoroObj).
* This corrects stale entries that arise when PM creates new node objects
* (e.g. via setNodeMarkup from other plugins) after a full-replace dispatch.
*/
function rebuildMappingFromDoc(mapping, doc) {
	doc.descendants((node) => {
		const cid = WEAK_NODE_TO_LORO_CONTAINER_MAPPING.get(node);
		if (cid != null) mapping.set(cid, node);
		return true;
	});
}
/**
* After a full-replace dispatch, the mapping entry for the root Loro container
* points to the pre-dispatch PM doc node (created by createNodeFromLoroObj).
* ProseMirror's tr.replace creates a new doc node, so `mapped === view.state.doc`
* fails in findContainerLocation, causing every subsequent incremental sync to
* return null (cascade fallback). Fix by updating the root entry to the actual
* post-dispatch doc node.
*/
function fixRootMapping(state, mapping, view) {
	const innerDoc = state.containerId ? state.doc.getContainerById(state.containerId) : state.doc.getMap(ROOT_DOC_KEY);
	if (innerDoc != null) mapping.set(innerDoc.id, view.state.doc);
}
/**
* Legacy full-document rebuild. Kept as the safety net for events that the
* incremental translator cannot (yet) handle — it is the historical behaviour
* of this plugin and is guaranteed to leave the PM doc in a state that
* matches Loro's view of the world.
*/
function fullReplaceFallback(view, event, state) {
	const mapping = state.mapping;
	clearChangedNodes(state.doc, event, mapping);
	const node = createNodeFromLoroObj(view.state.schema, state.containerId ? state.doc.getContainerById(state.containerId) : state.doc.getMap(ROOT_DOC_KEY), mapping, (e) => emitSyncEvent(state, {
		kind: "error",
		phase: "materialize",
		error: e
	}));
	if (node == null) {
		emitSyncEvent(state, {
			kind: "error",
			phase: "materialize",
			error: /* @__PURE__ */ new Error("createNodeFromLoroObj returned null on rebuild")
		});
		return;
	}
	const captureCursor = event.by !== "checkout";
	let anchor;
	let focus;
	if (captureCursor) try {
		const encoded = convertPmSelectionToCursors(view.state.doc, view.state.selection, state);
		anchor = encoded.anchor;
		focus = encoded.focus;
	} catch (_) {}
	const tr = view.state.tr.replace(0, view.state.doc.content.size, new Slice(Fragment.from(node), 0, 0));
	tr.setMeta(loroSyncPluginKey, {
		type: "non-local-updates",
		changedBy: event.by
	});
	tr.setMeta("addToHistory", false);
	view.dispatch(tr);
	fixRootMapping(state, mapping, view);
	rebuildMappingFromDoc(mapping, view.state.doc);
	if (anchor != null && !state.disableFallbackCursorRestore) queueMicrotask(() => {
		syncCursorsToPmSelection(view, anchor, focus);
	});
}
/**
* Update ProseMirror selection based on the given Loro cursors.
*/
function syncCursorsToPmSelection(view, anchor, focus) {
	if (view.isDestroyed) return;
	const state = loroSyncPluginKey.getState(view.state);
	if (!state) return;
	const { doc, mapping } = state;
	const anchorPos = cursorToAbsolutePosition(anchor, doc, mapping)[0];
	const focusPos = focus ? cursorToAbsolutePosition(focus, doc, mapping)[0] : void 0;
	if (anchorPos == null) return;
	safeSetSelection(view, anchorPos, focusPos ?? void 0);
}

//#endregion
//#region \0@oxc-project+runtime@0.112.0/helpers/typeof.js
function _typeof(o) {
	"@babel/helpers - typeof";
	return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o) {
		return typeof o;
	} : function(o) {
		return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o;
	}, _typeof(o);
}

//#endregion
//#region \0@oxc-project+runtime@0.112.0/helpers/toPrimitive.js
function toPrimitive(t, r) {
	if ("object" != _typeof(t) || !t) return t;
	var e = t[Symbol.toPrimitive];
	if (void 0 !== e) {
		var i = e.call(t, r || "default");
		if ("object" != _typeof(i)) return i;
		throw new TypeError("@@toPrimitive must return a primitive value.");
	}
	return ("string" === r ? String : Number)(t);
}

//#endregion
//#region \0@oxc-project+runtime@0.112.0/helpers/toPropertyKey.js
function toPropertyKey(t) {
	var i = toPrimitive(t, "string");
	return "symbol" == _typeof(i) ? i : i + "";
}

//#endregion
//#region \0@oxc-project+runtime@0.112.0/helpers/defineProperty.js
function _defineProperty(e, r, t) {
	return (r = toPropertyKey(r)) in e ? Object.defineProperty(e, r, {
		value: t,
		enumerable: !0,
		configurable: !0,
		writable: !0
	}) : e[r] = t, e;
}

//#endregion
//#region src/cursor/ephemeral.ts
var CursorEphemeralStore = class extends EphemeralStore {
	constructor(peer, timeout) {
		super(timeout);
		_defineProperty(this, "peer", void 0);
		this.peer = peer;
	}
	setLocal(state) {
		if (!state.anchor && !state.focus && !state.user) {
			this.delete(this.peer);
			return;
		}
		this.set(this.peer, {
			anchor: state.anchor?.encode() ?? null,
			focus: state.focus?.encode() ?? null,
			user: state.user ?? null
		});
	}
	getLocal() {
		const state = this.get(this.peer);
		if (!state) return;
		return {
			anchor: state.anchor ? Cursor.decode(state.anchor) : void 0,
			focus: state.focus ? Cursor.decode(state.focus) : void 0,
			user: state.user ?? void 0
		};
	}
	getAll() {
		const ans = {};
		for (const [peer, state] of Object.entries(this.getAllStates())) {
			if (!state) continue;
			ans[peer] = {
				anchor: state.anchor ? Cursor.decode(state.anchor) : void 0,
				focus: state.focus ? Cursor.decode(state.focus) : void 0,
				user: state.user ?? void 0
			};
		}
		return ans;
	}
	subscribeBy(listener) {
		return super.subscribe((event) => listener(event.by));
	}
};
const loroEphemeralCursorPluginKey = new PluginKey("loro-ephemeral-cursor");
const LoroEphemeralCursorPlugin = (store, options) => createCursorPlugin(loroEphemeralCursorPluginKey, ephemeralStoreAdapter(store), options);
const ephemeralStoreAdapter = (store) => ({
	getAll: () => store.getAll(),
	getLocal: () => store.getLocal(),
	setLocal: (state) => store.setLocal(state),
	subscribe: (listener) => store.subscribeBy(listener)
});

//#endregion
//#region src/cursor/awareness.ts
var CursorAwareness = class extends Awareness {
	constructor(peer, timeout = 3e4) {
		super(peer, timeout);
	}
	getAll() {
		const ans = {};
		for (const [peer, state] of Object.entries(this.getAllStates())) ans[peer] = {
			anchor: state.anchor ? Cursor.decode(state.anchor) : void 0,
			focus: state.focus ? Cursor.decode(state.focus) : void 0,
			user: state.user ? state.user : void 0
		};
		return ans;
	}
	setLocal(state) {
		this.setLocalState({
			anchor: state.anchor?.encode() || null,
			focus: state.focus?.encode() || null,
			user: state.user || null
		});
	}
	getLocal() {
		const state = this.getLocalState();
		if (!state) return;
		return {
			anchor: state.anchor && Cursor.decode(state.anchor),
			focus: state.focus && Cursor.decode(state.focus),
			user: state.user
		};
	}
};
const loroCursorPluginKey = new PluginKey("loro-cursor");
const awarenessAdapter = (awareness) => ({
	getAll: () => awareness.getAll(),
	getLocal: () => {
		const state = awareness.getLocal();
		if (!state) return;
		return {
			anchor: state.anchor ?? void 0,
			focus: state.focus ?? void 0,
			user: state.user ?? void 0
		};
	},
	setLocal: (state) => awareness.setLocal(state),
	subscribe: (listener) => {
		const awarenessListener = (_, origin) => listener(origin === "local" ? "local" : "import");
		awareness.addListener(awarenessListener);
		return () => awareness.removeListener(awarenessListener);
	}
});
const LoroCursorPlugin = (awareness, options) => createCursorPlugin(loroCursorPluginKey, awarenessAdapter(awareness), options);

//#endregion
//#region src/undo-plugin.ts
/**
* Tracks `UndoManager`s that already have an active `LoroUndoPlugin`
* binding. Loro's `setOnPush` / `setOnPop` are single-slot — a second
* mount would silently steal the callbacks from the first. We detect
* the conflict here and warn loudly so consumers know to use one
* UndoManager per editor.
*/
const BOUND_UNDO_MANAGERS = /* @__PURE__ */ new WeakSet();
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
function detectCompetingHistoryPlugin(state) {
	for (const plugin of state.plugins) {
		const pluginKey = plugin.key;
		if (typeof pluginKey === "string" && pluginKey.startsWith("history$")) return pluginKey;
	}
	return null;
}
const LoroUndoPlugin = (props) => {
	const undoManager = props.undoManager || new UndoManager(props.doc, {});
	undoManager.addExcludeOriginPrefix("sys:init");
	const logger = props.logger ?? defaultLogger;
	let latestPrevSelection = {
		anchor: null,
		focus: null
	};
	return new Plugin({
		key: loroUndoPluginKey,
		state: {
			init: (_config, editorState) => {
				configLoroTextStyle(props.doc, editorState.schema);
				return {
					undoManager,
					canUndo: undoManager.canUndo(),
					canRedo: undoManager.canRedo(),
					isUndoing: { current: false },
					prevSelection: null
				};
			},
			apply: (tr, state, oldEditorState, _newEditorState) => {
				const loroState = loroSyncPluginKey.getState(oldEditorState);
				const isInternal = tr.getMeta(loroSyncPluginKey) != null || tr.getMeta(loroUndoPluginKey) != null;
				const isHistoryTracked = tr.getMeta("addToHistory") !== false;
				const shouldCapture = !isInternal && tr.docChanged && isHistoryTracked && loroState != null;
				let prevSelection = state.prevSelection;
				if (shouldCapture) {
					const { anchor, focus } = convertPmSelectionToCursors(oldEditorState.doc, oldEditorState.selection, loroState);
					prevSelection = {
						anchor: anchor ?? null,
						focus: focus ?? null
					};
				}
				if (shouldCapture) latestPrevSelection = prevSelection ?? {
					anchor: null,
					focus: null
				};
				const canUndo = state.undoManager.canUndo();
				const canRedo = state.undoManager.canRedo();
				if (canUndo === state.canUndo && canRedo === state.canRedo && prevSelection === state.prevSelection) return state;
				return {
					...state,
					canUndo,
					canRedo,
					prevSelection
				};
			}
		},
		view: (view) => {
			if (BOUND_UNDO_MANAGERS.has(undoManager)) logger.warn("LoroUndoPlugin: this UndoManager is already bound to another editor. Loro's setOnPush/setOnPop are single-slot, so the previous binding's cursor capture and selection restore will stop working. Use a separate UndoManager per editor.");
			BOUND_UNDO_MANAGERS.add(undoManager);
			const competingHistoryName = detectCompetingHistoryPlugin(view.state);
			if (competingHistoryName != null) logger.warn(`LoroUndoPlugin: a competing PM history plugin ("${competingHistoryName}") is mounted in the same EditorState. Both will intercept undo independently; calling LoroUndoPlugin's \`undo\`/\`redo\` while the other plugin is also active causes desynchronization between PM history and the Loro op log. Either disable the competing history plugin (e.g. StarterKit.configure({ history: false })) or do not call LoroUndoPlugin's commands.`);
			undoManager.setOnPush((isUndo, _counterRange) => {
				const loroState = loroSyncPluginKey.getState(view.state);
				if (loroState?.doc == null) return {
					value: null,
					cursors: []
				};
				const cursors = [];
				let selection = latestPrevSelection;
				if (!isUndo) {
					const { anchor, focus } = convertPmSelectionToCursors(view.state.doc, view.state.selection, loroState);
					selection = {
						anchor: anchor ?? null,
						focus: focus ?? null
					};
				}
				if (selection.anchor) cursors.push(selection.anchor);
				if (selection.focus) cursors.push(selection.focus);
				return {
					value: null,
					cursors
				};
			});
			undoManager.setOnPop((_isUndo, meta, _counterRange) => {
				if (loroSyncPluginKey.getState(view.state)?.doc == null) return;
				const anchor = meta.cursors[0];
				const focus = meta.cursors[1];
				if (anchor == null) return;
				queueMicrotask(() => {
					if (view.isDestroyed) return;
					syncCursorsToPmSelection(view, anchor, focus);
				});
			});
			return { destroy: () => {
				undoManager.setOnPop();
				undoManager.setOnPush();
				BOUND_UNDO_MANAGERS.delete(undoManager);
			} };
		}
	});
};
function canUndo(state) {
	return loroUndoPluginKey.getState(state)?.undoManager.canUndo() || false;
}
function canRedo(state) {
	return loroUndoPluginKey.getState(state)?.undoManager.canRedo() || false;
}
const undo = (state, dispatch) => {
	const undoState = loroUndoPluginKey.getState(state);
	if (!undoState) return false;
	if (!dispatch) return undoState.undoManager.canUndo();
	undoState.isUndoing.current = true;
	try {
		return undoState.undoManager.undo();
	} finally {
		undoState.isUndoing.current = false;
	}
};
const redo = (state, dispatch) => {
	const undoState = loroUndoPluginKey.getState(state);
	if (!undoState) return false;
	if (!dispatch) return undoState.undoManager.canRedo();
	undoState.isUndoing.current = true;
	try {
		return undoState.undoManager.redo();
	} finally {
		undoState.isUndoing.current = false;
	}
};

//#endregion
//#region src/pm-diff.ts
/**
* pm-diff.ts — Minimal diff between two ProseMirror documents as real PM steps.
*
* Ported from y-prosemirror (src/sync-utils.js) by the Super Loop team.
* Original: https://github.com/yjs/y-prosemirror
*
* Key functions:
*   nodeToDelta(node)          — convert a PM node to a lib0 delta
*   deltaToPSteps(tr, diff)    — apply a delta diff as real PM steps
*   diffPmDocs(tr, old, new)   — compute diff and apply as PM steps
*
* Using real PM steps (ReplaceStep, AddMarkStep, etc.) means PM's native
* selection mapping handles cursor preservation automatically — no cursor
* guard or queueMicrotask needed.
*/
const marksToFormat = (marks) => {
	if (marks.length === 0) return null;
	const fmt = {};
	marks.forEach((m) => {
		fmt[m.type.name] = m.attrs;
	});
	return fmt;
};
const formatToMarks = (fmt, schema) => {
	if (!fmt) return [];
	return Object.entries(fmt).filter(([, v]) => v != null).map(([k, v]) => schema.mark(k, v)).filter(Boolean);
};
/**
* Convert a ProseMirror node to a lib0 delta.
* Text nodes → text ops. Block nodes → insert ops with nested delta.
*/
function nodeToDelta(node) {
	const d = delta.create(node.type.name);
	Object.entries(node.attrs).forEach(([k, v]) => {
		if (v != null) d.attrs[k] = v;
	});
	node.content.forEach((child) => {
		if (child.isText) d.insert(child.text ?? "", marksToFormat(child.marks));
		else d.insert([nodeToDelta(child)], marksToFormat(child.marks));
	});
	return d.done(false);
}
/**
* Apply a lib0 delta diff as real ProseMirror steps on the transaction.
* Adapted from y-prosemirror's deltaToPSteps.
*/
function deltaToPSteps(tr, d, pnode = tr.doc, currPos = { i: 0 }) {
	const schema = tr.doc.type.schema;
	let currParentIndex = 0;
	let nOffset = 0;
	const pchildren = pnode.content.content;
	for (const [k, v] of Object.entries(d.attrs ?? {})) tr.setNodeAttribute(currPos.i - 1, k, v);
	for (const op of d.children) if (delta.$retainOp.check(op)) {
		let i = op.retain;
		while (i > 0) {
			const pc = pchildren[currParentIndex];
			if (!pc) throw new Error("[pm-diff] retain out of bounds");
			if (pc.isText) {
				if (op.format != null) {
					const from = currPos.i;
					const to = currPos.i + Math.min(pc.nodeSize - nOffset, i);
					Object.entries(op.format).forEach(([k, v]) => {
						if (v == null) tr.removeMark(from, to, schema.marks[k]);
						else tr.addMark(from, to, schema.mark(k, v));
					});
				}
				if (i + nOffset < pc.nodeSize) {
					nOffset += i;
					currPos.i += i;
					i = 0;
				} else {
					currParentIndex++;
					i -= pc.nodeSize - nOffset;
					currPos.i += pc.nodeSize - nOffset;
					nOffset = 0;
				}
			} else {
				currParentIndex++;
				currPos.i += pc.nodeSize;
				i--;
			}
		}
	} else if (delta.$modifyOp.check(op)) {
		const child = pchildren[currParentIndex++];
		const childStart = currPos.i;
		const sizeBefore = tr.doc.content.size;
		currPos.i = childStart + 1;
		deltaToPSteps(tr, op.value, child, currPos);
		const netChange = tr.doc.content.size - sizeBefore;
		currPos.i = childStart + child.nodeSize + netChange;
	} else if (delta.$insertOp.check(op)) {
		const newNodes = op.insert.map((ins) => deltaToPNode(ins, schema, op.format));
		tr.replace(currPos.i, currPos.i, new Slice(Fragment.from(newNodes), 0, 0));
		currPos.i += newNodes.reduce((s, c) => c.nodeSize + s, 0);
	} else if (delta.$textOp.check(op)) {
		const marks = formatToMarks(op.format, schema);
		tr.replace(currPos.i, currPos.i, new Slice(Fragment.from(schema.text(op.insert, marks)), 0, 0));
		currPos.i += op.insert.length;
	} else if (delta.$deleteOp.check(op)) {
		let remaining = op.delete;
		while (remaining > 0) {
			const pc = pchildren[currParentIndex];
			if (!pc) throw new Error("[pm-diff] delete out of bounds");
			if (pc.isText) {
				const delLen = Math.min(pc.nodeSize - nOffset, remaining);
				tr.replace(currPos.i, currPos.i + delLen, Slice.empty);
				nOffset += delLen;
				if (nOffset === pc.nodeSize) {
					nOffset = 0;
					currParentIndex++;
				}
				remaining -= delLen;
			} else {
				tr.replace(currPos.i, currPos.i + pc.nodeSize, Slice.empty);
				currParentIndex++;
				remaining--;
			}
		}
	}
	return tr;
}
function deltaToPNode(d, schema, dformat) {
	const attrs = {};
	for (const [k, v] of Object.entries(d.attrs ?? {})) attrs[k] = v;
	const children = Array.from(d.children ?? []).flatMap((op) => {
		if (delta.$insertOp.check(op)) return op.insert.map((c) => deltaToPNode(c, schema, op.format));
		if (delta.$textOp.check(op)) return [schema.text(op.insert, formatToMarks(op.format, schema))];
		return [];
	});
	const nodeType = schema.nodes[d.name ?? "doc"];
	if (!nodeType) throw new Error(`[pm-diff] unknown node type: ${d.name}`);
	const node = nodeType.createAndFill(attrs, children, formatToMarks(dformat, schema));
	if (!node) throw new Error(`[pm-diff] createAndFill failed for: ${d.name}`);
	return node;
}
/**
* Compute the minimal diff between two PM docs and apply it as real PM steps.
* Returns the transaction with the steps applied, or null if docs are identical.
*/
function diffPmDocs(tr, oldDoc, newDoc) {
	const oldDelta = nodeToDelta(oldDoc);
	const newDelta = nodeToDelta(newDoc);
	const diff = delta.diff(oldDelta, newDelta);
	let hasChanges = false;
	for (const op of diff.children) if (!delta.$retainOp.check(op)) {
		hasChanges = true;
		break;
	}
	if (!hasChanges) return null;
	return deltaToPSteps(tr, diff);
}

//#endregion
export { ATTRIBUTES_KEY, CHILDREN_KEY, CursorAwareness, CursorEphemeralStore, LORO_SYNC_META, LoroCursorPlugin, LoroEphemeralCursorPlugin, LoroSyncPlugin, LoroUndoPlugin, NODE_NAME_KEY, ROOT_DOC_KEY, absolutePositionToCursor, canRedo, canUndo, convertPmSelectionToCursors, createConsoleLogger, createNodeFromLoroObj, cursorToAbsolutePosition, defaultLogger, deltaToPSteps, diffPmDocs, findContainerLocation, findEmptyTextPosition, getLoroSyncMeta, isLoroInternalTransaction, loroEventBatchToTransaction, loroSyncPluginKey, loroUndoPluginKey, nodeToDelta, redo, silentLogger, undo, updateLoroToPmState };
//# sourceMappingURL=index.js.map