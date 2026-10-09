import { describe, it, expect } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";

// Spreading an array into a call (`push(...xs)`, `Math.min(...xs)`) passes one
// argument per element, and V8's default stack runs out at roughly 125k of
// them. 150k clears that with margin.
const OVER_SPREAD_LIMIT = 150_000;

describe("extractGraph on inputs past the argument-spread limit", () => {
  it("merges a single file with more calls than a spread can pass", async () => {
    // Common Lisp extracts fastest per call, and a .lisp file in the batch also
    // runs the package-resolution pass over every merged call.
    const callees = Array.from({ length: OVER_SPREAD_LIMIT }, (_, i) => `(g${i})`);
    const content = `(in-package :big)\n(defun f () ${callees.join(" ")})\n`;

    const graph = await extractGraph([{ path: "/repo/big.lisp", content }]);

    expect(graph.calls).toHaveLength(OVER_SPREAD_LIMIT);
    expect(graph.calls[0]).toMatchObject({ caller: "big:f", callee: "g0" });
    expect(graph.calls[OVER_SPREAD_LIMIT - 1]).toMatchObject({
      caller: "big:f",
      callee: `g${OVER_SPREAD_LIMIT - 1}`,
    });
  });

  it("finds the common root of a batch with more files than a spread can pass", async () => {
    // .txt has no grammar, so each file costs nothing to extract.
    const files = Array.from({ length: OVER_SPREAD_LIMIT }, (_, i) => ({
      path: `/repo/notes/n${i}.txt`,
      content: "",
    }));

    const graph = await extractGraph(files);

    expect(graph.files).toEqual([]);
  });
});
