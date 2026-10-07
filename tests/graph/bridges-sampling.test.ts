import { describe, it, expect } from "vitest";
import { UndirectedGraph } from "graphology";
import betweennessModule from "graphology-metrics/centrality/betweenness.js";
import { detectBridges } from "../../src/graph/insights.js";
import { runAnalysisFromGraph } from "../../src/graph/analyses.js";
import { graphToProlog } from "../../src/graph/facts.js";
import type { CodeGraph } from "../../src/graph/types.js";

const betweenness = betweennessModule as unknown as (
  graph: UndirectedGraph,
  options?: { normalized?: boolean },
) => Record<string, number>;

function graphFromEdges(edges: Array<[string, string]>): CodeGraph {
  return {
    defines: [],
    calls: edges.map(([caller, callee]) => ({ caller, callee })),
    imports: [],
    exports: [],
    contains: [],
  };
}

/** Deterministic random graph: a spanning tree plus `extra` random edges per node. */
function randomGraph(n: number, extra: number, seed = 7, prefix = "n"): Array<[string, string]> {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const edges: Array<[string, string]> = [];
  for (let i = 1; i < n; i++) {
    edges.push([`${prefix}${i}`, `${prefix}${Math.floor(rnd() * i)}`]);
    for (let j = 0; j < extra; j++) edges.push([`${prefix}${i}`, `${prefix}${Math.floor(rnd() * n)}`]);
  }
  return edges;
}

/**
 * Two random clusters whose only connection is `hinge`. The hinge links to
 * several nodes on each side so every cross-cluster shortest path runs
 * through it alone — it is the unique top-betweenness node.
 */
function plantedBridge(clusterSize: number, seedL: number, seedR: number): Array<[string, string]> {
  const edges = [...randomGraph(clusterSize, 2, seedL, "l"), ...randomGraph(clusterSize, 2, seedR, "r")];
  for (const i of [3, 50, 400, 900]) {
    edges.push([`l${i}`, "hinge"], ["hinge", `r${i}`]);
  }
  return edges;
}

/** Today's exact implementation, inlined so the regression is pinned independently of src. */
function exactTop3(graph: CodeGraph): Array<{ name: string; score: number }> {
  const nodes = new Set<string>();
  for (const c of graph.calls) { nodes.add(c.caller); nodes.add(c.callee); }
  const g = new UndirectedGraph();
  for (const n of nodes) g.addNode(n);
  for (const c of graph.calls) {
    if (c.caller === c.callee) continue;
    if (!g.hasEdge(c.caller, c.callee)) g.addEdge(c.caller, c.callee);
  }
  return Object.entries(betweenness(g, { normalized: true }))
    .filter(([, s]) => s > 0)
    .map(([name, score]) => ({ name, score }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, 3);
}

describe("detectBridges: exact regime (small graphs)", () => {
  it("is byte-identical to exact Brandes betweenness below the size threshold", () => {
    const cases = [
      graphFromEdges([
        ["a", "b"], ["b", "c"], ["a", "c"],
        ["d", "e"], ["e", "f"], ["d", "f"],
        ["c", "bridge"], ["bridge", "d"],
      ]),
      graphFromEdges(randomGraph(300, 2, 11)),
      graphFromEdges(randomGraph(1500, 2, 3)),
    ];
    for (const g of cases) {
      expect(JSON.stringify(detectBridges(g))).toBe(JSON.stringify(exactTop3(g)));
    }
  });

  it("does not mark small-graph results as approximate", async () => {
    const g = graphFromEdges(randomGraph(300, 2, 11));
    const r = await runAnalysisFromGraph(g, { analysis: "bridges" });
    expect(Object.keys(r)).toEqual(["analysis", "result"]);
    expect(JSON.stringify(r.result)).toBe(JSON.stringify(exactTop3(g)));
  });
});

describe("detectBridges: sampled regime (large graphs)", () => {
  // ~12k nodes / ~36k edges — the size of a 500-file Clojure slice of a real
  // repo. Exact Brandes is O(V·E) here (~30-40s); the sampled estimate must
  // stay well inside a request budget.
  const big = graphFromEdges(randomGraph(12_000, 2, 5));

  it("bounds runtime on a large graph and marks the result approximate", async () => {
    const t0 = performance.now();
    const r = await runAnalysisFromGraph(big, { analysis: "bridges" });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(5_000);
    expect(r.analysis).toBe("bridges");
    const approx = (r as unknown as { approximate?: Record<string, unknown> }).approximate;
    expect(approx).toBeDefined();
    expect(approx).toMatchObject({ method: "sampled-brandes", nodes: 12_000 });
    expect(approx!.pivots).toBeGreaterThan(0);
    expect(approx!.pivots).toBeLessThan(12_000);
    const bridges = r.result as Array<{ name: string; score: number }>;
    expect(bridges.length).toBe(3);
    for (const b of bridges) expect(b.score).toBeGreaterThan(0);
  }, 60_000);

  it("is deterministic: the same graph yields byte-identical output", () => {
    const a = JSON.stringify(detectBridges(big));
    const b = JSON.stringify(detectBridges(big));
    expect(a).toBe(b);
  }, 60_000);

  it("picks the same pivots regardless of edge insertion order", () => {
    // A planted bridge between two random clusters: whatever order the call
    // edges arrive in, the top bridge must be the same node.
    const edges = plantedBridge(1_600, 21, 22);
    const forward = detectBridges(graphFromEdges(edges));
    const reversed = detectBridges(graphFromEdges([...edges].reverse()));
    expect(forward[0].name).toBe("hinge");
    expect(reversed[0].name).toBe("hinge");
    expect(reversed.map((b) => b.name)).toEqual(forward.map((b) => b.name));
  }, 60_000);

  it("tracks exact betweenness on a planted-bridge graph", () => {
    const g = graphFromEdges(plantedBridge(1_200, 31, 32));
    const exact = exactTop3(g);
    const sampled = detectBridges(g, { exactMaxNodes: 500 });
    expect(sampled[0].name).toBe(exact[0].name);
    expect(Math.abs(sampled[0].score - exact[0].score) / exact[0].score).toBeLessThan(0.1);
  }, 60_000);

  it("annotates bridge/2 facts as approximate when sampled", () => {
    const program = graphToProlog(big, undefined, { includeInsights: true });
    // Boolean asserts: a failing toMatch would dump the multi-MB program.
    expect(/^% bridge\/2 scores are approximate/m.test(program)).toBe(true);
    expect(/^bridge\(/m.test(program)).toBe(true);
  }, 60_000);
});
