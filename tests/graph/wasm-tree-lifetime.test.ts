import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { extractGraph } from "../../src/graph/extractor.js";

// Same module instance parser.ts loads (shared CJS require cache).
const { Parser } = createRequire(import.meta.url)("web-tree-sitter");

/**
 * extractGraph used to start every file at once. WASM-grammar files parse
 * after an await, so every file in the batch was parsed before the first
 * tree was walked and freed: all trees lived in web-tree-sitter's WASM heap
 * together. Over brian's 3,864 .clj files that peaked at 2.55 GB RSS
 * against 0.5 GB one file at a time, and the wasm32 heap tops out at 4 GB.
 */
describe("WASM tree lifetime during extractGraph", () => {
  it("walks and frees each tree before parsing the next file", async () => {
    const files = Array.from({ length: 30 }, (_, i) => ({
      path: `/virtual/ns${i}.clj`,
      content: `(ns ns${i})\n(defn f${i} [x] (g${i} x))\n(defn g${i} [x] x)\n`,
    }));
    const parse = Parser.prototype.parse;
    let live = 0;
    let maxLive = 0;
    Parser.prototype.parse = function (this: unknown, ...args: unknown[]) {
      const tree = parse.apply(this, args);
      maxLive = Math.max(maxLive, ++live);
      const del = tree.delete.bind(tree);
      tree.delete = () => {
        live--;
        del();
      };
      return tree;
    };
    try {
      const graph = await extractGraph(files);
      expect(graph.defines).toHaveLength(60);
    } finally {
      Parser.prototype.parse = parse;
    }
    expect(live).toBe(0);
    expect(maxLive).toBe(1);
  });
});
