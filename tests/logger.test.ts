import { describe, expect, test } from "vitest";

// @vitest-environment jsdom

import { LoroDoc } from "loro-crdt";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import {
  type LoroLogger,
  createConsoleLogger,
  defaultLogger,
  silentLogger,
} from "../src/logger";
import { LoroSyncPlugin } from "../src/sync-plugin";
import { LoroUndoPlugin } from "../src/undo-plugin";
import {
  type LoroDocType,
  type LoroNode,
  updateLoroToPmState,
} from "../src/lib";

import { schema } from "./schema";
import { createEditorState } from "./utils";

const helloWorld = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Hello world" }] },
  ],
};

// Capture every method call into an array of [level, message, ctx] tuples.
function makeRecordingLogger(): {
  logger: LoroLogger;
  calls: Array<[string, string, Record<string, unknown> | undefined]>;
} {
  const calls: Array<[string, string, Record<string, unknown> | undefined]> =
    [];
  return {
    logger: {
      error: (msg, ctx) => calls.push(["error", msg, ctx]),
      warn: (msg, ctx) => calls.push(["warn", msg, ctx]),
      info: (msg, ctx) => calls.push(["info", msg, ctx]),
      debug: (msg, ctx) => calls.push(["debug", msg, ctx]),
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// createConsoleLogger: level filtering
// ---------------------------------------------------------------------------

describe("createConsoleLogger (level filtering)", () => {
  test("level='silent' suppresses every call", () => {
    const realError = console.error;
    const realWarn = console.warn;
    const realInfo = console.info;
    const realDebug = console.debug;
    let count = 0;
    console.error =
      console.warn =
      console.info =
      console.debug =
        () => {
          count++;
        };
    try {
      const lg = createConsoleLogger("silent");
      lg.error("a");
      lg.warn("b");
      lg.info("c");
      lg.debug("d");
      expect(count).toBe(0);
    } finally {
      console.error = realError;
      console.warn = realWarn;
      console.info = realInfo;
      console.debug = realDebug;
    }
  });

  test("level='warn' (default) lets error+warn through, suppresses info+debug", () => {
    let errs = 0,
      wrns = 0,
      infs = 0,
      dbgs = 0;
    const realE = console.error,
      realW = console.warn,
      realI = console.info,
      realD = console.debug;
    console.error = () => errs++;
    console.warn = () => wrns++;
    console.info = () => infs++;
    console.debug = () => dbgs++;
    try {
      const lg = createConsoleLogger("warn");
      lg.error("e");
      lg.warn("w");
      lg.info("i");
      lg.debug("d");
      expect(errs).toBe(1);
      expect(wrns).toBe(1);
      expect(infs).toBe(0);
      expect(dbgs).toBe(0);
    } finally {
      console.error = realE;
      console.warn = realW;
      console.info = realI;
      console.debug = realD;
    }
  });

  test("level='debug' lets all four through", () => {
    let total = 0;
    const realE = console.error,
      realW = console.warn,
      realI = console.info,
      realD = console.debug;
    const inc = () => total++;
    console.error = inc;
    console.warn = inc;
    console.info = inc;
    console.debug = inc;
    try {
      const lg = createConsoleLogger("debug");
      lg.error("e");
      lg.warn("w");
      lg.info("i");
      lg.debug("d");
      expect(total).toBe(4);
    } finally {
      console.error = realE;
      console.warn = realW;
      console.info = realI;
      console.debug = realD;
    }
  });

  test("custom prefix is included in the output", () => {
    const captured: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args);
    };
    try {
      const lg = createConsoleLogger("error", "[my-app]");
      lg.error("oops", { code: 42 });
      expect(captured.length).toBe(1);
      expect(captured[0][0]).toBe("[my-app] oops");
      expect(captured[0][1]).toEqual({ code: 42 });
    } finally {
      console.error = realError;
    }
  });

  test("calls without context omit the second argument", () => {
    const captured: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args);
    };
    try {
      const lg = createConsoleLogger("error");
      lg.error("simple");
      expect(captured.length).toBe(1);
      expect(captured[0]).toHaveLength(1);
      expect(captured[0][0]).toBe("[loro-prosemirror] simple");
    } finally {
      console.error = realError;
    }
  });
});

// ---------------------------------------------------------------------------
// silentLogger / defaultLogger
// ---------------------------------------------------------------------------

describe("silentLogger / defaultLogger", () => {
  test("silentLogger does not call console even at error level", () => {
    let count = 0;
    const realError = console.error;
    console.error = () => count++;
    try {
      silentLogger.error("e");
      silentLogger.warn("w");
      silentLogger.info("i");
      silentLogger.debug("d");
      expect(count).toBe(0);
    } finally {
      console.error = realError;
    }
  });

  test("defaultLogger.warn delegates to console.warn", () => {
    let warnCalled = 0;
    const realWarn = console.warn;
    console.warn = () => warnCalled++;
    try {
      defaultLogger.warn("test");
      expect(warnCalled).toBe(1);
    } finally {
      console.warn = realWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// Plugin integration: custom logger receives lifecycle messages
// ---------------------------------------------------------------------------

describe("LoroSyncPlugin (custom logger integration)", () => {
  test("debug-level logger captures lifecycle traces from updateNodeOnLoroEvent", async () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));

    // Build a second peer to send a remote event.
    const docB: LoroDocType = new LoroDoc();
    docB.import(doc.export({ mode: "snapshot" }));

    const { logger, calls } = makeRecordingLogger();
    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON({ type: "doc", content: [] }),
        schema,
        plugins: [LoroSyncPlugin({ doc: docB, logger })],
      }),
    });
    try {
      // Mutate doc A and import update into docB.
      const root = doc.getMap("doc") as LoroNode;
      const para = root.get("children")?.get(0) as LoroNode;
      const text = (para.get("children") as { get(i: number): unknown }).get(
        0,
      ) as import("loro-crdt").LoroText;
      text.insert(0, "Z");
      doc.commit();

      docB.import(doc.export({ mode: "update", from: docB.oplogVersion() }));
      await new Promise((r) => setTimeout(r, 10));

      // The logger should have received at least one debug entry from
      // updateNodeOnLoroEvent's "processing Loro event batch" trace.
      const debugEntries = calls.filter(([level]) => level === "debug");
      expect(debugEntries.length).toBeGreaterThan(0);
      expect(
        debugEntries.some(([, msg]) =>
          msg.includes("processing Loro event batch"),
        ),
      ).toBe(true);
    } finally {
      view.destroy();
      place.remove();
    }
  });

  test("error logger captures emitSyncEvent hook throws", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const { logger, calls } = makeRecordingLogger();

    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON({ type: "doc", content: [] }),
        schema,
        plugins: [
          LoroSyncPlugin({
            doc,
            logger,
            onSyncEvent: () => {
              throw new Error("test: hook throws");
            },
          }),
        ],
      }),
    });
    try {
      const errorEntries = calls.filter(([level]) => level === "error");
      // At least one error entry from the onSyncEvent throw during the
      // init dispatch.
      expect(errorEntries.length).toBeGreaterThan(0);
      expect(
        errorEntries.some(([, msg]) => msg.includes("onSyncEvent hook threw")),
      ).toBe(true);
    } finally {
      view.destroy();
      place.remove();
    }
  });

  test("LoroUndoPlugin's history-warning goes through the logger", () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));
    const { logger, calls } = makeRecordingLogger();

    // Mount with prosemirror-history to trigger the warning.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { history } = require("prosemirror-history");

    const place = document.createElement("div");
    document.body.appendChild(place);
    const view = new EditorView(place, {
      state: EditorState.create({
        doc: schema.nodeFromJSON({ type: "doc", content: [] }),
        schema,
        plugins: [
          history(),
          LoroSyncPlugin({ doc }),
          LoroUndoPlugin({ doc, logger }),
        ],
      }),
    });
    try {
      const warnEntries = calls.filter(([level]) => level === "warn");
      expect(
        warnEntries.some(([, msg]) =>
          msg.includes("competing PM history plugin"),
        ),
      ).toBe(true);
    } finally {
      view.destroy();
      place.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// silentLogger plugin integration: zero console output on a normal flow
// ---------------------------------------------------------------------------

describe("LoroSyncPlugin (silentLogger)", () => {
  test("normal mount + dispatch produces zero console output", async () => {
    const doc: LoroDocType = new LoroDoc();
    updateLoroToPmState(doc, new Map(), createEditorState(schema, helloWorld));

    let consoleOutput = 0;
    const realE = console.error,
      realW = console.warn,
      realI = console.info,
      realD = console.debug,
      realL = console.log;
    const stub = () => consoleOutput++;
    console.error = stub;
    console.warn = stub;
    console.info = stub;
    console.debug = stub;
    console.log = stub;
    try {
      const place = document.createElement("div");
      document.body.appendChild(place);
      const view = new EditorView(place, {
        state: EditorState.create({
          doc: schema.nodeFromJSON({ type: "doc", content: [] }),
          schema,
          plugins: [LoroSyncPlugin({ doc, logger: silentLogger })],
        }),
      });
      try {
        view.dispatch(view.state.tr.insertText("X", 1));
        await new Promise((r) => setTimeout(r, 5));
        expect(consoleOutput).toBe(0);
      } finally {
        view.destroy();
        place.remove();
      }
    } finally {
      console.error = realE;
      console.warn = realW;
      console.info = realI;
      console.debug = realD;
      console.log = realL;
    }
  });
});
