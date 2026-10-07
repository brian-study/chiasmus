import { describe, it, expect } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";

/**
 * extractGraph starts every file before any of them finishes, so on a cold
 * thread each WASM-grammar file used to run web-tree-sitter's Parser.init()
 * and Language.load() itself: one runtime instance and one grammar instance
 * per file, and grammars bound to whichever runtime instance they loaded
 * into. The graph worker makes cold threads the common case (every recycle),
 * so init and grammar loads must be shared by concurrent callers.
 *
 * This file must stay the only WASM user in its test process: the counts
 * below assume nothing was loaded before.
 */
describe("web-tree-sitter initialisation on a cold thread", () => {
  it("instantiates the runtime once and each grammar file once", async () => {
    const wasm = (globalThis as any).WebAssembly;
    const original = wasm.instantiate;
    let instantiations = 0;
    wasm.instantiate = (...args: unknown[]) => {
      instantiations++;
      return original.apply(wasm, args);
    };
    try {
      const files: Array<{ path: string; content: string }> = [];
      for (let i = 0; i < 8; i++) {
        files.push({ path: `/virtual/ns${i}.clj`, content: `(ns ns${i})\n(defn f${i} [x] (g${i} x))\n(defn g${i} [x] x)\n` });
        files.push({ path: `/virtual/s${i}.scm`, content: `(define (f${i} x) (g${i} x))\n(define (g${i} x) x)\n` });
        // Racket reuses the Scheme grammar file.
        files.push({ path: `/virtual/r${i}.rkt`, content: `(define (f${i} x) (g${i} x))\n(define (g${i} x) x)\n` });
      }
      const graph = await extractGraph(files);
      // Every file parsed: two definitions each.
      expect(graph.defines).toHaveLength(files.length * 2);
      // Runtime + clojure grammar + scheme grammar (shared with racket).
      expect(instantiations).toBe(3);
    } finally {
      wasm.instantiate = original;
    }
  });
});
