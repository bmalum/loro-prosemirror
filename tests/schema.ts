import { Schema, type NodeSpec, type MarkSpec } from "prosemirror-model";

const nodes: { [key: string]: NodeSpec } = {
  doc: {
    content: "block*",
  },
  noteTitle: {
    attrs: { emoji: { default: "" } },
    content: "text*",
    group: "block",
    toDOM: (node) => ["h1", { "data-emoji": String(node.attrs.emoji) }, 0],
  },
  paragraph: {
    content: "inline*",
    group: "block",
    toDOM: () => ["p", 0],
  },
  bulletList: {
    content: "listItem+",
    group: "block",
    toDOM: () => ["ul", 0],
  },
  listItem: {
    content: "paragraph block*",
    toDOM: () => ["li", 0],
  },
  text: {
    group: "inline",
  },
};

const marks: { [key: string]: MarkSpec } = {
  bold: {
    toDOM: () => ["strong", 0],
  },
  italic: {
    toDOM: () => ["em", 0],
  },
};

export const schema = new Schema({ nodes, marks });
