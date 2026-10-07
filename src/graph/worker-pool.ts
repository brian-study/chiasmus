/**
 * Runs chiasmus_graph / chiasmus_map jobs on a persistent worker thread so
 * tree-sitter extraction and graph analysis never block the MCP request
 * thread (HTTP sessions, /healthz, initialize).
 *
 * One worker at a time, fed by a bounded FIFO queue — the work is CPU-bound,
 * so a second worker would only contend. The worker is kept between jobs
 * (grammars stay loaded) and replaced, before the next job runs, when it:
 *   - crashes or exits (including a resourceLimits overrun, which V8 reports
 *     as ERR_WORKER_OUT_OF_MEMORY instead of killing the process),
 *   - reports a fatal WASM error (web-tree-sitter state is then undefined),
 *   - runs past the job timeout (terminated mid-job),
 *   - leaves process RSS above the cap after a job (web-tree-sitter's WASM
 *     heap only grows and lives outside resourceLimits, and native
 *     tree-sitter memory only goes back to the OS when the thread exits),
 *   - has served maxJobsPerWorker jobs, or sits idle past idleTimeoutMs.
 */

import { Worker, SHARE_ENV, type ResourceLimits } from "node:worker_threads";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { handleGraph, handleMap } from "./tool-handlers.js";
import { hasCodeRegisteredAdapters } from "./adapter-registry.js";

export type GraphTool = "chiasmus_graph" | "chiasmus_map";

export interface GraphJob {
  tool: GraphTool;
  args: Record<string, unknown>;
  /** Run chiasmus-adapter-* discovery in the worker before the job (config.adapterDiscovery). */
  discoverAdapters?: boolean;
}

/** main → worker */
export interface GraphJobMessage {
  type: "job";
  id: number;
  tool: GraphTool;
  args: Record<string, unknown>;
  discoverAdapters: boolean;
}

/** main → worker: end the thread once the current job (if any) has stopped. */
export interface GraphExitMessage {
  type: "exit";
}

export type GraphWorkerMessage = GraphJobMessage | GraphExitMessage;

export interface GraphWorkerData {
  /** Int32Array flag; non-zero means stop the running job at the next file. */
  cancel: SharedArrayBuffer;
}

/** worker → main */
export interface GraphResultMessage {
  type: "result";
  id: number;
  result: CallToolResult;
  /** Set when the job hit a fatal WASM error: the worker must not be reused. */
  fatal?: string;
  /**
   * Process RSS after the job. Per-isolate figures miss most of it: a full
   * brian map left ~1 GB of JS + WASM heap but 3.5 GB RSS, 2.2 GB of which
   * terminating the worker returned (`external` even read >100 GB mid-job).
   */
  rssBytes: number;
}

export interface GraphWorkerPoolOptions {
  /** Jobs allowed to wait behind the running one before new jobs are rejected. */
  maxQueue?: number;
  /** Replace the worker after it has served this many jobs. */
  maxJobsPerWorker?: number;
  /** Terminate and replace the worker when a job runs longer than this. */
  jobTimeoutMs?: number;
  /** Terminate an idle worker after this long (frees its WASM heap). */
  idleTimeoutMs?: number;
  /** Replace the worker when the process RSS after a job exceeds this. */
  maxRssBytes?: number;
  /** V8 limits for the worker isolate; an overrun kills only the worker. */
  resourceLimits?: ResourceLimits;
  /** How long a busy worker gets to stop cooperatively before terminate(). */
  cancelGraceMs?: number;
  /** Worker entry point. Defaults to the bundled graph-worker script. */
  workerUrl?: URL;
  /** Node flags for the worker. Defaults to tsx's loader when running from source. */
  execArgv?: string[];
}

const DEFAULTS = {
  maxQueue: 32,
  maxJobsPerWorker: 100,
  jobTimeoutMs: 10 * 60_000,
  idleTimeoutMs: 5 * 60_000,
  maxRssBytes: 2 * 1024 ** 3,
  resourceLimits: { maxOldGenerationSizeMb: 4096 } as ResourceLimits,
  cancelGraceMs: 3_000,
};

type RecycleReason = "crash" | "fatal-wasm" | "timeout" | "memory" | "max-jobs" | "idle" | "shutdown";

interface Slot {
  worker: Worker;
  jobs: number;
  retired: boolean;
  error?: Error;
  /** Shared with the worker; see GraphWorkerData. */
  cancel: Int32Array;
  exited: Promise<void>;
}

interface Pending {
  id: number;
  job: GraphJob;
  resolve: (r: CallToolResult) => void;
  /** Worker the job was dispatched to, once running. */
  slot?: Slot;
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
}

/**
 * Worker entry for a pool module at `moduleUrl`. The compiled worker sits
 * next to it in dist/. Under tsx or vitest the module is the .ts source, so
 * the worker is too and needs tsx's loader.
 */
export function workerEntryFor(moduleUrl: string, execArgv: string[]): { url: URL; execArgv?: string[] } {
  if (moduleUrl.endsWith(".ts")) {
    // The `tsx` CLI passes its loader as .../tsx/dist/{preflight.cjs,loader.mjs}.
    const hasTsx = execArgv.some((a) => a === "tsx" || /[\\/]tsx[\\/]dist[\\/]/.test(a));
    return {
      url: new URL("./graph-worker.ts", moduleUrl),
      execArgv: hasTsx ? execArgv : [...execArgv, "--import", "tsx"],
    };
  }
  return { url: new URL("./graph-worker.js", moduleUrl) };
}

export class GraphWorkerPool {
  private readonly opts: Required<Omit<GraphWorkerPoolOptions, "workerUrl" | "execArgv">>;
  private readonly workerUrl: URL;
  private readonly execArgv?: string[];
  private slot: Slot | null = null;
  private queue: Pending[] = [];
  private active: Pending | null = null;
  private jobTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private closed = false;

  constructor(options: GraphWorkerPoolOptions = {}) {
    this.opts = {
      maxQueue: options.maxQueue ?? DEFAULTS.maxQueue,
      maxJobsPerWorker: options.maxJobsPerWorker ?? DEFAULTS.maxJobsPerWorker,
      jobTimeoutMs: options.jobTimeoutMs ?? DEFAULTS.jobTimeoutMs,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      maxRssBytes: options.maxRssBytes ?? DEFAULTS.maxRssBytes,
      resourceLimits: options.resourceLimits ?? DEFAULTS.resourceLimits,
      cancelGraceMs: options.cancelGraceMs ?? DEFAULTS.cancelGraceMs,
    };
    const entry = options.workerUrl
      ? { url: options.workerUrl }
      : workerEntryFor(import.meta.url, process.execArgv);
    this.workerUrl = entry.url;
    this.execArgv = options.execArgv ?? (options.workerUrl ? undefined : entry.execArgv);
  }

  /** Queue a job. Never rejects: failures come back as `{ error }` tool results. */
  run(job: GraphJob): Promise<CallToolResult> {
    if (this.closed) return Promise.resolve(errorResult("graph worker pool is shut down"));
    if (this.active && this.queue.length >= this.opts.maxQueue) {
      return Promise.resolve(errorResult(
        `graph worker queue is full (${this.queue.length} jobs waiting); retry later`,
      ));
    }
    return new Promise((resolve) => {
      this.queue.push({ id: this.nextId++, job, resolve });
      this.pump();
    });
  }

  /** Fail queued and running jobs, terminate the worker, refuse new jobs. */
  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    this.clearJobTimer();
    const pending = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = null;
    this.queue = [];
    for (const p of pending) p.resolve(errorResult("graph worker pool is shut down"));
    const slot = this.slot;
    if (slot) await this.retire(slot, "shutdown");
  }

  private pump(): void {
    if (this.active || this.closed) return;
    const next = this.queue.shift();
    if (!next) {
      this.armIdleTimer();
      return;
    }
    this.clearIdleTimer();
    const slot = this.slot ?? this.spawn();
    next.slot = slot;
    this.active = next;
    // Hold the process open only while a job is in flight.
    slot.worker.ref();
    this.jobTimer = setTimeout(() => this.onTimeout(slot), this.opts.jobTimeoutMs);
    this.jobTimer.unref();
    const msg: GraphJobMessage = {
      type: "job",
      id: next.id,
      tool: next.job.tool,
      args: next.job.args,
      discoverAdapters: next.job.discoverAdapters ?? false,
    };
    slot.worker.postMessage(msg);
  }

  private spawn(): Slot {
    const cancel = new SharedArrayBuffer(4);
    const workerData: GraphWorkerData = { cancel };
    const worker = new Worker(this.workerUrl, {
      env: SHARE_ENV,
      workerData,
      resourceLimits: this.opts.resourceLimits,
      ...(this.execArgv ? { execArgv: this.execArgv } : {}),
    });
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => { markExited = resolve; });
    const slot: Slot = { worker, jobs: 0, retired: false, cancel: new Int32Array(cancel), exited };
    worker.on("message", (m: GraphResultMessage) => this.onMessage(slot, m));
    // 'error' (uncaught exception, ERR_WORKER_OUT_OF_MEMORY) is followed by 'exit'.
    worker.on("error", (e) => { slot.error ??= e; });
    worker.on("messageerror", (e) => this.onDeath(slot, `${e.name}: ${e.message}`));
    worker.on("exit", (code) => {
      markExited();
      this.onDeath(slot, slot.error ? `${slot.error.name}: ${slot.error.message}` : `exit code ${code}`);
    });
    worker.unref();
    this.slot = slot;
    return slot;
  }

  private onMessage(slot: Slot, m: GraphResultMessage): void {
    const done = this.active;
    if (slot !== this.slot || !done || m?.type !== "result" || m.id !== done.id) return;
    this.clearJobTimer();
    this.active = null;
    slot.jobs++;
    let reason: RecycleReason | null = null;
    if (m.fatal) reason = "fatal-wasm";
    else if (m.rssBytes > this.opts.maxRssBytes) reason = "memory";
    else if (slot.jobs >= this.opts.maxJobsPerWorker) reason = "max-jobs";
    if (reason) void this.retire(slot, reason, m.fatal);
    else slot.worker.unref();
    done.resolve(m.result);
    this.pump();
  }

  /** Unplanned loss of a worker (crash, exit, undeliverable result). */
  private onDeath(slot: Slot, detail: string): void {
    if (slot.retired) return;
    void this.retire(slot, "crash", detail);
    const failed = this.active;
    if (!failed || failed.slot !== slot) return;
    this.clearJobTimer();
    this.active = null;
    failed.resolve(errorResult(`graph worker crashed while running ${failed.job.tool}: ${detail}`));
    this.pump();
  }

  private onTimeout(slot: Slot): void {
    const timedOut = this.active;
    if (slot !== this.slot || !timedOut) return;
    this.jobTimer = null;
    this.active = null;
    void this.retire(slot, "timeout");
    timedOut.resolve(errorResult(
      `${timedOut.job.tool} exceeded ${this.opts.jobTimeoutMs}ms and was aborted; the graph worker was restarted`,
    ));
    this.pump();
  }

  /**
   * Stop a worker. worker.terminate() (and process.exit()) while the thread
   * is inside native tree-sitter aborts the whole process — node-addon-api's
   * Napi::Error escapes during teardown — so ask first: the cancel flag stops
   * a running job at the next file, then the queued `exit` message ends the
   * thread from JS. terminate() only after the grace period, by which point
   * the thread is almost certainly in JS or WASM, where it is safe.
   */
  private async retire(slot: Slot, reason: RecycleReason, detail?: string): Promise<void> {
    if (slot.retired) return;
    slot.retired = true;
    if (this.slot === slot) this.slot = null;
    if (reason !== "idle" && reason !== "shutdown" && reason !== "max-jobs") {
      console.error(`[Chiasmus] graph worker recycled (${reason}${detail ? `: ${detail}` : ""})`);
    }
    if (reason === "crash") {
      await slot.worker.terminate();
      return;
    }
    Atomics.store(slot.cancel, 0, 1);
    slot.worker.postMessage({ type: "exit" } satisfies GraphExitMessage);
    let grace: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([
      slot.exited.then(() => true),
      new Promise<boolean>((resolve) => { grace = setTimeout(() => resolve(false), this.opts.cancelGraceMs); }),
    ]);
    clearTimeout(grace);
    if (!stopped) await slot.worker.terminate();
  }

  private armIdleTimer(): void {
    const slot = this.slot;
    if (!slot || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.slot === slot && !this.active) void this.retire(slot, "idle");
    }, this.opts.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearJobTimer(): void {
    if (this.jobTimer) clearTimeout(this.jobTimer);
    this.jobTimer = null;
  }
}

function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** CHIASMUS_GRAPH_WORKER=0|off|false runs graph tools on the calling thread. */
function workerDisabled(): boolean {
  const v = process.env.CHIASMUS_GRAPH_WORKER?.toLowerCase();
  return v === "0" || v === "off" || v === "false";
}

let shared: GraphWorkerPool | null = null;

/** The process-wide pool, shared by every MCP session. */
export function getGraphWorkerPool(): GraphWorkerPool {
  if (!shared) {
    const heapMb = positiveIntEnv("CHIASMUS_GRAPH_WORKER_HEAP_MB");
    shared = new GraphWorkerPool({
      jobTimeoutMs: positiveIntEnv("CHIASMUS_GRAPH_JOB_TIMEOUT_MS"),
      resourceLimits: heapMb ? { maxOldGenerationSizeMb: heapMb } : undefined,
    });
  }
  return shared;
}

/**
 * Run a graph tool job off the request thread — or inline when the worker is
 * disabled, or when adapters were registered in code on this thread: the
 * worker has its own registry and cannot load them, so their files would
 * silently drop out of the result.
 */
export function runGraphTool(job: GraphJob): Promise<CallToolResult> {
  if (workerDisabled() || hasCodeRegisteredAdapters()) {
    return job.tool === "chiasmus_map" ? handleMap(job.args) : handleGraph(job.args);
  }
  return getGraphWorkerPool().run(job);
}

/** Terminate the shared worker; called on server shutdown. */
export async function shutdownGraphWorkers(): Promise<void> {
  const pool = shared;
  shared = null;
  await pool?.close();
}
