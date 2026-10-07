/**
 * Runs chiasmus_graph / chiasmus_map jobs on a persistent worker thread so
 * tree-sitter extraction and graph analysis never block the MCP request
 * thread (other tool calls, pings, cancellation).
 *
 * One worker at a time, fed by a bounded FIFO queue — the work is CPU-bound,
 * so a second worker would only contend. The worker is kept between jobs
 * (grammars stay loaded) and replaced, before the next job runs, when it:
 *   - crashes or exits (including a resourceLimits overrun, which V8 reports
 *     as ERR_WORKER_OUT_OF_MEMORY instead of killing the process),
 *   - reports a fatal WASM error (web-tree-sitter state is then undefined),
 *   - runs past the job timeout (terminated mid-job),
 *   - has grown process RSS past the cap since it started, measured after a
 *     job (web-tree-sitter's WASM heap only grows and lives outside
 *     resourceLimits, and native tree-sitter memory only goes back to the
 *     OS when the thread exits),
 *   - has served maxJobsPerWorker jobs, or sits idle past idleTimeoutMs,
 *   - is running a job whose request was cancelled.
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
  /** The MCP request's signal: a cancelled job is dropped if queued, stopped if running. */
  signal?: AbortSignal;
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
   * Process RSS after the job. Per-isolate figures (heap, `external`) miss
   * native tree-sitter memory, which the OS only gets back when the thread
   * exits.
   */
  rssBytes: number;
  /**
   * Process RSS when this worker started. The pool judges the growth since
   * then: memory a retired worker freed can stay in the process (allocator
   * arenas), and judged on absolute RSS every later job would recycle again.
   */
  startRssBytes: number;
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
  /** Replace the worker when process RSS after a job exceeds its RSS at the worker's start by more than this. */
  maxRssGrowthBytes?: number;
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
  maxRssGrowthBytes: 2 * 1024 ** 3,
  resourceLimits: { maxOldGenerationSizeMb: 4096 } as ResourceLimits,
  cancelGraceMs: 3_000,
};

type RecycleReason = "crash" | "fatal-wasm" | "timeout" | "cancelled" | "memory" | "max-jobs" | "idle" | "shutdown";

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

function cancelledResult(job: GraphJob): CallToolResult {
  return errorResult(`${job.tool} was cancelled by the client`);
}

/** Flags (with their values) a source worker needs: module loaders and resolve conditions. */
const LOADER_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--conditions", "-C"]);

/**
 * The loader flags in `execArgv`. Node rejects per-process and V8 flags
 * (`--max-old-space-size`, `--expose-gc`, `--title`, ...) in an explicit
 * worker execArgv — new Worker() throws — though it lets a worker inherit them.
 */
function loaderFlags(execArgv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i];
    const eq = arg.indexOf("=");
    if (!LOADER_FLAGS.has(eq === -1 ? arg : arg.slice(0, eq))) continue;
    if (eq !== -1) out.push(arg);
    else if (i + 1 < execArgv.length) out.push(arg, execArgv[++i]);
  }
  return out;
}

/**
 * Worker entry for a pool module at `moduleUrl`. The compiled worker sits
 * next to it in dist/ and inherits the parent's flags. Under tsx or vitest
 * the module is the .ts source, so the worker is too and needs tsx's loader,
 * which means an explicit execArgv.
 */
export function workerEntryFor(moduleUrl: string, execArgv: string[]): { url: URL; execArgv?: string[] } {
  if (moduleUrl.endsWith(".ts")) {
    const loaders = loaderFlags(execArgv);
    // The `tsx` CLI passes its loader as .../tsx/dist/{preflight.cjs,loader.mjs}.
    const hasTsx = loaders.some((a) => a === "tsx" || /[\\/]tsx[\\/]dist[\\/]/.test(a));
    return {
      url: new URL("./graph-worker.ts", moduleUrl),
      execArgv: hasTsx ? loaders : [...loaders, "--import", "tsx"],
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
  /** Stops of retired workers still in progress (cooperative exit or terminate()). */
  private readonly stopping = new Set<Promise<void>>();

  constructor(options: GraphWorkerPoolOptions = {}) {
    this.opts = {
      maxQueue: options.maxQueue ?? DEFAULTS.maxQueue,
      maxJobsPerWorker: options.maxJobsPerWorker ?? DEFAULTS.maxJobsPerWorker,
      jobTimeoutMs: options.jobTimeoutMs ?? DEFAULTS.jobTimeoutMs,
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      maxRssGrowthBytes: options.maxRssGrowthBytes ?? DEFAULTS.maxRssGrowthBytes,
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
    if (job.signal?.aborted) return Promise.resolve(cancelledResult(job));
    if (this.active && this.queue.length >= this.opts.maxQueue) {
      return Promise.resolve(errorResult(
        `graph worker queue is full (${this.queue.length} jobs waiting); retry later`,
      ));
    }
    return new Promise((resolve) => {
      const pending: Pending = { id: this.nextId++, job, resolve };
      const signal = job.signal;
      if (signal) {
        const onAbort = () => this.cancel(pending);
        signal.addEventListener("abort", onAbort, { once: true });
        pending.resolve = (r) => {
          signal.removeEventListener("abort", onAbort);
          resolve(r);
        };
      }
      this.queue.push(pending);
      this.pump();
    });
  }

  /**
   * Fail queued and running jobs, refuse new jobs, and stop every worker —
   * including one already retiring (e.g. after a timeout) — before resolving,
   * so a shutdown never exits the process under a running worker.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    this.clearJobTimer();
    const pending = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = null;
    this.queue = [];
    for (const p of pending) p.resolve(errorResult("graph worker pool is shut down"));
    if (this.slot) this.retire(this.slot, "shutdown");
    await Promise.all(this.stopping);
  }

  private pump(): void {
    if (this.active || this.closed) return;
    const next = this.queue.shift();
    if (!next) {
      this.armIdleTimer();
      return;
    }
    this.clearIdleTimer();
    let slot: Slot;
    try {
      slot = this.slot ?? this.spawn();
    } catch (e) {
      // new Worker() can throw synchronously (e.g. ERR_WORKER_INVALID_EXEC_ARGV).
      // pump() also runs from worker listeners and timers, where a throw
      // would be an uncaught exception in the server.
      next.resolve(errorResult(
        `graph worker could not start for ${next.job.tool}: ${e instanceof Error ? e.message : String(e)}`,
      ));
      this.pump();
      return;
    }
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
    else if (m.rssBytes - m.startRssBytes > this.opts.maxRssGrowthBytes) reason = "memory";
    else if (slot.jobs >= this.opts.maxJobsPerWorker) reason = "max-jobs";
    if (reason) this.retire(slot, reason, m.fatal);
    else slot.worker.unref();
    done.resolve(m.result);
    this.pump();
  }

  /** Unplanned loss of a worker (crash, exit, undeliverable result). */
  private onDeath(slot: Slot, detail: string): void {
    if (slot.retired) return;
    this.retire(slot, "crash", detail);
    const failed = this.active;
    if (!failed || failed.slot !== slot) return;
    this.clearJobTimer();
    this.active = null;
    failed.resolve(errorResult(`graph worker crashed while running ${failed.job.tool}: ${detail}`));
    this.pump();
  }

  /**
   * The job's request was cancelled (client cancellation or disconnect):
   * drop it if still queued; if running, stop its worker as on a timeout,
   * so the next job doesn't wait behind work nobody will read.
   */
  private cancel(p: Pending): void {
    const queued = this.queue.indexOf(p);
    if (queued !== -1) {
      this.queue.splice(queued, 1);
      p.resolve(cancelledResult(p.job));
      return;
    }
    if (this.active !== p || !p.slot) return;
    this.clearJobTimer();
    this.active = null;
    this.retire(p.slot, "cancelled");
    p.resolve(cancelledResult(p.job));
    this.pump();
  }

  private onTimeout(slot: Slot): void {
    const timedOut = this.active;
    if (slot !== this.slot || !timedOut) return;
    this.jobTimer = null;
    this.active = null;
    this.retire(slot, "timeout");
    timedOut.resolve(errorResult(
      `${timedOut.job.tool} exceeded ${this.opts.jobTimeoutMs}ms and was aborted; the graph worker was restarted`,
    ));
    this.pump();
  }

  /** Take a worker out of service and stop it; close() waits for the stop. */
  private retire(slot: Slot, reason: RecycleReason, detail?: string): void {
    if (slot.retired) return;
    slot.retired = true;
    if (this.slot === slot) this.slot = null;
    if (reason !== "idle" && reason !== "shutdown" && reason !== "max-jobs") {
      console.error(`[Chiasmus] graph worker recycled (${reason}${detail ? `: ${detail}` : ""})`);
    }
    const stopping = this.stop(slot, reason === "crash").catch(() => undefined);
    this.stopping.add(stopping);
    void stopping.then(() => this.stopping.delete(stopping));
  }

  /**
   * Stop a worker. worker.terminate() (and process.exit()) while the thread
   * is inside native tree-sitter aborts the whole process — node-addon-api's
   * Napi::Error escapes during teardown — so ask first: the cancel flag stops
   * a running job at the next file, then the queued `exit` message ends the
   * thread from JS. terminate() only after the grace period. The flag is
   * checked between files, so if one file's native parse or tree walk
   * outlasts the grace period, terminate() can still land inside native code.
   */
  private async stop(slot: Slot, immediate: boolean): Promise<void> {
    if (immediate) {
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
      if (this.slot === slot && !this.active) this.retire(slot, "idle");
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

function positiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Pool limits from CHIASMUS_GRAPH_WORKER_HEAP_MB and
 * CHIASMUS_GRAPH_JOB_TIMEOUT_MS; unset or invalid values keep the defaults.
 */
export function poolOptionsFromEnv(env: NodeJS.ProcessEnv): GraphWorkerPoolOptions {
  const heapMb = positiveInt(env.CHIASMUS_GRAPH_WORKER_HEAP_MB);
  return {
    jobTimeoutMs: positiveInt(env.CHIASMUS_GRAPH_JOB_TIMEOUT_MS),
    resourceLimits: heapMb ? { maxOldGenerationSizeMb: heapMb } : undefined,
  };
}

/** CHIASMUS_GRAPH_WORKER=0|off|false runs graph tools on the calling thread. */
function workerDisabled(): boolean {
  const v = process.env.CHIASMUS_GRAPH_WORKER?.toLowerCase();
  return v === "0" || v === "off" || v === "false";
}

let shared: GraphWorkerPool | null = null;

/** The process-wide pool: one graph worker per process, shared by every server created in it. */
export function getGraphWorkerPool(): GraphWorkerPool {
  shared ??= new GraphWorkerPool(poolOptionsFromEnv(process.env));
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

/**
 * Stop the shared worker and refuse graph jobs from then on; called on
 * server shutdown. The closed pool stays in place, so a call arriving while
 * the server drains gets an error instead of spawning a fresh worker.
 */
export async function shutdownGraphWorkers(): Promise<void> {
  await getGraphWorkerPool().close();
}
