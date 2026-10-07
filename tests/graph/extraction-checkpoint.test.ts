import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { extractGraph, setExtractionCheckpoint } from "../../src/graph/extractor.js";

// Same module instance parser.ts loads (shared CJS require cache).
const { Parser } = createRequire(import.meta.url)("web-tree-sitter");

function cljFiles(n: number): Array<{ path: string; content: string }> {
  return Array.from({ length: n }, (_, i) => ({
    path: `/virtual/ns${i}.clj`,
    content: `(ns ns${i})\n(defn f${i} [x] (g${i} x))\n(defn g${i} [x] x)\n`,
  }));
}

afterEach(() => {
  setExtractionCheckpoint(null);
});

/**
 * The graph worker stops a cancelled job through the extraction checkpoint.
 * extractGraph starts every file before any finishes, and WASM-grammar files
 * only parse after an await — so a checkpoint run only on entry fires for
 * every file before the first parse, and a cancel never stops the batch.
 */
describe("extraction checkpoint with WASM grammars", () => {
  it("stops the batch at the next parse once the checkpoint throws, freeing parsed trees", async () => {
    // Warm the grammar, as in a worker that has served a job.
    await extractGraph(cljFiles(1));

    const parse = Parser.prototype.parse;
    let parses = 0;
    let deleted = 0;
    Parser.prototype.parse = function (this: unknown, ...args: unknown[]) {
      parses++;
      const tree = parse.apply(this, args);
      const del = tree.delete.bind(tree);
      tree.delete = () => {
        deleted++;
        del();
      };
      return tree;
    };
    try {
      setExtractionCheckpoint(() => {
        if (parses > 0) throw new Error("graph job cancelled");
      });
      await expect(extractGraph(cljFiles(20))).rejects.toThrow("graph job cancelled");
      // Let the batch's other files settle.
      await new Promise((r) => setTimeout(r, 50));
      expect(parses).toBe(1);
      expect(deleted).toBe(parses);
    } finally {
      Parser.prototype.parse = parse;
    }
  });

  it("does not interfere when the checkpoint never throws", async () => {
    let calls = 0;
    setExtractionCheckpoint(() => {
      calls++;
    });
    const graph = await extractGraph(cljFiles(5));
    expect(graph.defines).toHaveLength(10);
    expect(calls).toBeGreaterThanOrEqual(5);
  });
});
