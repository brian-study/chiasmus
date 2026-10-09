import { UndirectedGraph } from "graphology";
import betweennessModule from "graphology-metrics/centrality/betweenness.js";
import type { CodeGraph } from "./types.js";
import { detectCommunities, type Community } from "./community.js";
import { buildUndirectedGraph, collectNodes, entriesByName, undirectedDegree, forEachUndirectedEdge } from "./graph-util.js";

const betweennessCentrality = betweennessModule as unknown as (
  graph: UndirectedGraph,
  options?: { normalized?: boolean },
) => Record<string, number>;

export interface Hub {
  name: string;
  degree: number;
}

export interface Bridge {
  name: string;
  score: number;
}

export type SurpriseReason = "cross-community" | "peripheral-to-hub";

export interface SurprisingConnection {
  source: string;
  target: string;
  score: number;
  reasons: SurpriseReason[];
}

export interface HubOptions {
  topN?: number;
}

const DEFAULT_HUB_TOP_N = 10;

export function detectHubs(graph: CodeGraph, opts: HubOptions = {}): Hub[] {
  const topN = opts.topN ?? DEFAULT_HUB_TOP_N;
  const degree = undirectedDegree(graph);

  return [...degree.entries()]
    .map(([name, d]) => ({ name, degree: d }))
    .sort((a, b) => {
      if (b.degree !== a.degree) return b.degree - a.degree;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .slice(0, topN);
}

/**
 * Exact Brandes betweenness is O(V·E): ~1s at 2k nodes, ~40s at 12k (a
 * 500-file Clojure slice). Above this node count the score is estimated
 * from a sample of BFS sources instead.
 */
const EXACT_BETWEENNESS_MAX_NODES = 2_000;
/** BFS sources (pivots) used by the sampled estimate. */
const BETWEENNESS_PIVOTS = 500;
const BETWEENNESS_PIVOT_SEED = 42;

export interface BridgeOptions {
  /** Largest graph (node count) scored with exact betweenness. */
  exactMaxNodes?: number;
  /**
   * Pivot count for the sampled estimate on larger graphs. Rounded down and
   * clamped to [1, node count]; NaN falls back to the default (500).
   */
  pivots?: number;
}

/** Present on a bridges result when its scores are a sampled estimate. */
export interface BetweennessApproximation {
  method: "sampled-brandes";
  nodes: number;
  pivots: number;
  seed: number;
}

export interface BridgeAnalysis {
  bridges: Bridge[];
  approximate?: BetweennessApproximation;
}

export function detectBridges(graph: CodeGraph, opts: BridgeOptions = {}): Bridge[] {
  return analyzeBridges(graph, opts).bridges;
}

/**
 * Top-3 betweenness nodes. Small graphs get exact Brandes (graphology);
 * larger ones get the Brandes–Pich pivot estimate, with pivots drawn by a
 * seeded PRNG over the sorted node names: output is reproducible, the pivot
 * set is independent of edge order, and scores agree across edge orders up
 * to floating-point rounding. `approximate` is set only in the second case.
 */
export function analyzeBridges(graph: CodeGraph, opts: BridgeOptions = {}): BridgeAnalysis {
  const nodes = collectNodes(graph);
  if (nodes.size === 0) return { bridges: [] };

  const exactMaxNodes = opts.exactMaxNodes ?? EXACT_BETWEENNESS_MAX_NODES;
  if (nodes.size <= exactMaxNodes) {
    const view = buildUndirectedGraph(graph, nodes);
    return { bridges: topBridges(entriesByName(view, betweennessCentrality(view.graph, { normalized: true }))) };
  }

  const requested = Math.floor(opts.pivots ?? BETWEENNESS_PIVOTS);
  const pivots = Math.min(nodes.size, Math.max(1, Number.isNaN(requested) ? BETWEENNESS_PIVOTS : requested));
  const { names, scores } = sampledBetweenness(graph, nodes, pivots, BETWEENNESS_PIVOT_SEED);
  const entries: Array<[string, number]> = names.map((n, i) => [n, scores[i]]);
  return {
    bridges: topBridges(entries),
    approximate: { method: "sampled-brandes", nodes: nodes.size, pivots, seed: BETWEENNESS_PIVOT_SEED },
  };
}

function topBridges(entries: Array<[string, number]>): Bridge[] {
  return entries
    .filter(([, s]) => s > 0)
    .map(([name, score]) => ({ name, score }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    })
    .slice(0, 3);
}

/** mulberry32 — tiny seeded PRNG, enough for reproducible pivot draws. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Unweighted Brandes accumulation from `k` pivot sources over the same
 * undirected view `buildUndirectedGraph` produces (self-loops and duplicate
 * edges dropped). Each source's dependencies are scaled by n/k — an unbiased
 * estimate of the all-sources sum — then normalized by 1/((n-1)(n-2)),
 * matching graphology's `normalized: true` for undirected graphs.
 */
function sampledBetweenness(
  graph: CodeGraph,
  nodes: Set<string>,
  k: number,
  seed: number,
): { names: string[]; scores: Float64Array } {
  const names = [...nodes];
  const n = names.length;
  const index = new Map<string, number>();
  names.forEach((name, i) => index.set(name, i));

  // Adjacency as CSR: dedupe undirected pairs, then bucket by endpoint.
  const seen = new Set<number>();
  const pairA: number[] = [];
  const pairB: number[] = [];
  const degree = new Int32Array(n);
  for (const c of graph.calls) {
    if (c.caller === c.callee) continue;
    const a = index.get(c.caller)!;
    const b = index.get(c.callee)!;
    const key = a < b ? a * n + b : b * n + a;
    if (seen.has(key)) continue;
    seen.add(key);
    pairA.push(a);
    pairB.push(b);
    degree[a]++;
    degree[b]++;
  }
  const offset = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) offset[i + 1] = offset[i] + degree[i];
  const adj = new Int32Array(offset[n]);
  const fill = offset.slice(0, n);
  for (let e = 0; e < pairA.length; e++) {
    adj[fill[pairA[e]]++] = pairB[e];
    adj[fill[pairB[e]]++] = pairA[e];
  }

  // Pivots: partial Fisher–Yates over name-sorted indices.
  const order = names.map((_, i) => i).sort((x, y) => (names[x] < names[y] ? -1 : names[x] > names[y] ? 1 : 0));
  const rand = mulberry32(seed);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (n - i));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }

  const scores = new Float64Array(n);
  const sigma = new Float64Array(n);
  const dist = new Int32Array(n);
  const delta = new Float64Array(n);
  const stack = new Int32Array(n);
  for (let p = 0; p < k; p++) {
    const s = order[p];
    dist.fill(-1);
    sigma.fill(0);
    dist[s] = 0;
    sigma[s] = 1;
    // BFS; `stack` doubles as the queue since vertices leave in BFS order.
    let head = 0;
    let tail = 0;
    stack[tail++] = s;
    while (head < tail) {
      const v = stack[head++];
      for (let e = offset[v]; e < offset[v + 1]; e++) {
        const w = adj[e];
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          stack[tail++] = w;
        }
        if (dist[w] === dist[v] + 1) sigma[w] += sigma[v];
      }
    }
    // Dependency accumulation in reverse BFS order.
    for (let i = 0; i < tail; i++) delta[stack[i]] = 0;
    for (let i = tail - 1; i > 0; i--) {
      const w = stack[i];
      const coeff = (1 + delta[w]) / sigma[w];
      for (let e = offset[w]; e < offset[w + 1]; e++) {
        const v = adj[e];
        if (dist[v] === dist[w] - 1) delta[v] += sigma[v] * coeff;
      }
      scores[w] += delta[w];
    }
  }

  const scale = n <= 2 ? 0 : n / k / ((n - 1) * (n - 2));
  for (let i = 0; i < n; i++) scores[i] *= scale;
  return { names, scores };
}

export interface SurpriseOptions {
  /** Pre-computed communities. When omitted, this function runs Louvain itself. */
  communities?: Community[];
  topN?: number;
}

/**
 * Score each unique undirected edge for "surprise": cross-community edges
 * and peripheral-to-hub edges each add 1. Scoring weights match graphify's
 * _surprise_score; signals chiasmus doesn't emit yet (confidence labels,
 * semantic similarity, cross-repo buckets) simply contribute 0.
 */
export function detectSurprisingConnections(
  graph: CodeGraph,
  options: SurpriseOptions = {},
): SurprisingConnection[] {
  const communities = options.communities ?? detectCommunities(graph);
  const topN = options.topN ?? 10;

  const nodeToCommunity = new Map<string, number>();
  for (const c of communities) for (const m of c.members) nodeToCommunity.set(m, c.id);

  const degree = undirectedDegree(graph);

  const candidates: SurprisingConnection[] = [];
  forEachUndirectedEdge(graph, (a, b) => {
    let score = 0;
    const reasons: SurpriseReason[] = [];

    const ca = nodeToCommunity.get(a);
    const cb = nodeToCommunity.get(b);
    if (ca !== undefined && cb !== undefined && ca !== cb) {
      score += 1;
      reasons.push("cross-community");
    }

    const da = degree.get(a) ?? 0;
    const db = degree.get(b) ?? 0;
    if (Math.min(da, db) <= 2 && Math.max(da, db) >= 5) {
      score += 1;
      reasons.push("peripheral-to-hub");
    }

    if (score > 0) {
      candidates.push({ source: a, target: b, score, reasons });
    }
  });

  candidates.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    if (x.source !== y.source) return x.source < y.source ? -1 : 1;
    return x.target < y.target ? -1 : x.target > y.target ? 1 : 0;
  });

  return candidates.slice(0, topN);
}
