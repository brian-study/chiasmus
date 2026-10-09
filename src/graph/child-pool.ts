/**
 * Runs chiasmus_graph / chiasmus_map jobs in a persistent child process
 * (graph-child.ts, on ChildPool from ../child/pool.ts), so tree-sitter
 * extraction and graph analysis never block the MCP server (other tool
 * calls, pings, cancellation), and so a job can always be stopped: the child
 * is killed with SIGKILL. A worker thread can't be stopped like that —
 * worker.terminate() while the thread is inside native tree-sitter makes
 * node-addon-api's Napi::Error escape and aborts the whole process.
 *
 * One child at a time — the work is CPU-bound, so a second child would only
 * contend. Grammars stay loaded between jobs. The child is replaced after a
 * fatal web-tree-sitter error, when its RSS after a job is over the cap
 * (web-tree-sitter's WASM heap only grows, and native tree-sitter memory goes
 * back to the OS only when the process exits), and for the other reasons
 * ChildPool lists. SIGKILL loses nothing: cache files are written to a temp
 * file and renamed into place, and a cache lock the child held goes stale.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ChildPool, childEntry, positiveInt, switchedOff, type ChildKind, type ChildPoolOptions, type ResultMessage } from "../child/pool.js";
import { handleGraph, handleMap } from "./tool-handlers.js";
import { discoveryStarted, hasCodeRegisteredAdapters } from "./adapter-registry.js";

export type GraphTool = "chiasmus_graph" | "chiasmus_map";

export interface GraphJob {
  tool: GraphTool;
  args: Record<string, unknown>;
  /** Run chiasmus-adapter-* discovery in the child before the job (config.adapterDiscovery). */
  discoverAdapters?: boolean;
  /** The MCP request's signal: a cancelled job is dropped if queued, killed if running. */
  signal?: AbortSignal;
}

/** parent → child */
export interface GraphJobMessage {
  type: "job";
  id: number;
  tool: GraphTool;
  args: Record<string, unknown>;
  discoverAdapters: boolean;
  /**
   * The parent's working directory and environment when the job starts. The
   * child adopts them first, so the job sees what an inline call would:
   * defaultRepoKey() hashes the working directory, and the cache location
   * comes from CHIASMUS_CACHE_DIR or HOME.
   */
  cwd?: string;
  env: Record<string, string | undefined>;
}

/** child → parent */
export type GraphResultMessage = ResultMessage<CallToolResult>;

export type GraphChildPoolOptions = ChildPoolOptions;

function currentCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    // The directory was removed; the child keeps its own.
    return undefined;
  }
}

const GRAPH: ChildKind<GraphJob, CallToolResult> = {
  worker: "graph worker",
  jobName: (job) => job.tool,
  message: (job): Omit<GraphJobMessage, "type" | "id"> => ({
    tool: job.tool,
    args: job.args,
    discoverAdapters: job.discoverAdapters ?? false,
    cwd: currentCwd(),
    env: { ...process.env },
  }),
  errorResult: (message) => ({ content: [{ type: "text", text: JSON.stringify({ error: message }) }] }),
};

/** Child entry for a pool module at `moduleUrl`: graph-child beside it. */
export function childEntryFor(moduleUrl: string, execArgv: string[]): { path: string; execArgv: string[] } {
  return childEntry("graph-child", moduleUrl, execArgv);
}

export class GraphChildPool extends ChildPool<GraphJob, CallToolResult> {
  constructor(options: GraphChildPoolOptions = {}) {
    super(GRAPH, childEntryFor(import.meta.url, process.execArgv), options);
  }
}

/**
 * Pool limits from CHIASMUS_GRAPH_WORKER_HEAP_MB and
 * CHIASMUS_GRAPH_JOB_TIMEOUT_MS; unset or invalid values keep the defaults.
 * A timeout over 2^31-1 ms (about 24.8 days) is capped there.
 */
export function poolOptionsFromEnv(env: NodeJS.ProcessEnv): GraphChildPoolOptions {
  return {
    jobTimeoutMs: positiveInt(env.CHIASMUS_GRAPH_JOB_TIMEOUT_MS),
    heapMb: positiveInt(env.CHIASMUS_GRAPH_WORKER_HEAP_MB),
  };
}

let shared: GraphChildPool | null = null;

/** The process-wide pool: one graph child per process, shared by every server created in it. */
export function getGraphChildPool(): GraphChildPool {
  shared ??= new GraphChildPool(poolOptionsFromEnv(process.env));
  return shared;
}

/**
 * Run a graph tool job in the graph child — or inline when the child is
 * disabled (CHIASMUS_GRAPH_WORKER=0|off|false), when its entry is missing (a
 * bundled build), or when adapters were registered in code in this process:
 * the child has its own registry and cannot load them, so their files would
 * silently drop out of the result. Once this process has run adapter
 * discovery (config.adapterDiscovery, or a library caller's own
 * discoverAdapters()), the child runs it too, whatever the job's flag, so
 * it sees the adapters an inline call would.
 */
export function runGraphTool(job: GraphJob): Promise<CallToolResult> {
  if (switchedOff(process.env.CHIASMUS_GRAPH_WORKER) || hasCodeRegisteredAdapters() || !getGraphChildPool().entryAvailable) {
    return job.tool === "chiasmus_map" ? handleMap(job.args) : handleGraph(job.args);
  }
  return getGraphChildPool().run({ ...job, discoverAdapters: job.discoverAdapters || discoveryStarted() });
}

/**
 * Kill the shared graph child and refuse graph jobs from then on; called on
 * server shutdown. The closed pool stays in place, so a call arriving while
 * the server drains gets an error instead of starting a fresh child.
 */
export async function shutdownGraphChild(): Promise<void> {
  await getGraphChildPool().close();
}
