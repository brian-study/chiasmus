import { describe, it, expect } from "vitest";
import { extractGraph } from "../../src/graph/extractor.js";
import { runAnalysisFromGraph } from "../../src/graph/analyses.js";
import { detectCommunities } from "../../src/graph/community.js";
import { analyzeBridges, detectSurprisingConnections } from "../../src/graph/insights.js";
import type { CodeGraph } from "../../src/graph/types.js";

// Names that collide with Object.prototype members: toString, constructor,
// valueOf, hasOwnProperty, __proto__, ...
const PROTO_NAMES = Object.getOwnPropertyNames(Object.prototype);

function g(calls: Array<[string, string]>, defines: string[] = []): CodeGraph {
  const names = new Set(defines);
  for (const [a, b] of calls) { names.add(a); names.add(b); }
  return {
    defines: [...names].map((n) => ({ file: "t.ts", name: n, kind: "function", line: 1 })),
    calls: calls.map(([caller, callee]) => ({ caller, callee })),
    imports: [],
    exports: [],
    contains: [],
  };
}

function members(graph: CodeGraph): string[] {
  return detectCommunities(graph).flatMap((c) => c.members).sort();
}

describe("insight analyses on nodes named after Object.prototype members", () => {
  it("handle a two-line file that calls toString", async () => {
    const graph = await extractGraph([{
      path: "label.ts",
      content: "function label(x) { return x.toString(); }\nfunction main() { return label(1); }\n",
    }]);
    expect(graph.calls).toContainEqual(expect.objectContaining({ caller: "label", callee: "toString" }));

    const communities = await runAnalysisFromGraph(graph, { analysis: "communities" });
    const communityMembers = (communities.result as Array<{ members: string[] }>).flatMap((c) => c.members);
    expect(communityMembers.sort()).toEqual(["label", "main", "toString"]);

    const bridges = await runAnalysisFromGraph(graph, { analysis: "bridges" });
    expect(bridges.result).toEqual([{ name: "label", score: 1 }]);

    await expect(runAnalysisFromGraph(graph, { analysis: "surprises" })).resolves.toBeDefined();

    const facts = await runAnalysisFromGraph(graph, { analysis: "facts", includeInsights: true });
    expect(facts.result).toContain("bridge(label, 1.0000).");
  });

  it("communities place every such node exactly once", () => {
    const graph = g(PROTO_NAMES.map((n) => ["hub", n]));
    expect(members(graph)).toEqual(["hub", ...PROTO_NAMES].sort());
  });

  it("communities keep isolated nodes with such names", () => {
    const graph = g([["a", "b"]], PROTO_NAMES);
    expect(members(graph)).toEqual(["a", "b", ...PROTO_NAMES].sort());
  });

  it("bridges score a node with such a name", () => {
    for (const name of PROTO_NAMES) {
      const graph = g([["a", name], [name, "b"]]);
      expect(analyzeBridges(graph).bridges).toEqual([{ name, score: 1 }]);
    }
  });

  it("surprises score edges to such nodes", () => {
    const graph = g(PROTO_NAMES.map((n) => ["hub", n]));
    const surprises = detectSurprisingConnections(graph, { topN: PROTO_NAMES.length });
    expect(surprises.map((s) => [s.source, s.target].sort().join("|")).sort())
      .toEqual(PROTO_NAMES.map((n) => ["hub", n].sort().join("|")).sort());
  });
});
