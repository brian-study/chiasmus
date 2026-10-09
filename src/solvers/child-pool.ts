/**
 * Runs solves in child processes (solver-child.ts, on ChildPool from
 * ../child/pool.ts), so a solver crash costs the solve that caused it, not
 * the server and every session in it. Z3 and SWI-Prolog are WASM modules
 * that a single input can break for good: a stack overflow on a large input,
 * a heap exhausted by a small one, Prolog's halt. In this process that meant
 * exiting so a supervisor could restart it (exitOnFatalSolverError); in a
 * child, the pool replaces the child and the next solve gets a fresh module.
 * A running solve can also be stopped now: cancelling its request, or a job
 * timeout, kills its child.
 *
 * One child per solver, so a long Z3 check doesn't hold up Prolog queries;
 * each runs one solve at a time, as the modules do in-process. A cold start
 * costs about a second (Z3) or half a second (Prolog), and a child holds
 * 100-200 MiB between solves, so an idle child is kept for 30 minutes.
 */

import { ChildPool, childEntry, positiveInt, switchedOff, type ChildKind, type ChildPoolOptions } from "../child/pool.js";
import type {
  PrologBatchInput,
  SolveOptions,
  Solver,
  SolverInput,
  SolverResult,
  SolverType,
} from "./types.js";

export interface SolverJob {
  input: SolverInput | PrologBatchInput;
  /** Aborting it drops the job if queued, kills its child if running. */
  signal?: AbortSignal;
}

/** parent → child */
export interface SolverJobMessage {
  type: "job";
  id: number;
  solver: SolverType;
  /** A PrologBatchInput (it has `queries`) runs through solveBatch. */
  input: SolverInput | PrologBatchInput;
}

export type SolverChildPoolOptions = ChildPoolOptions;

const SOLVER_IDLE_TIMEOUT_MS = 30 * 60_000;
const SOLVER_MAX_JOBS_PER_CHILD = 1000;

function solverKind(type: SolverType): ChildKind<SolverJob, SolverResult[]> {
  return {
    worker: `${type} solver worker`,
    jobName: () => `${type} solve`,
    message: (job): Omit<SolverJobMessage, "type" | "id"> => ({ solver: type, input: job.input }),
    errorResult: (error) => [{ status: "error", error }],
  };
}

/** Runs `type` solves in a child process; each job resolves to one result per query. */
export class SolverChildPool extends ChildPool<SolverJob, SolverResult[]> {
  constructor(type: SolverType, options: SolverChildPoolOptions = {}) {
    super(solverKind(type), childEntry("solver-child", import.meta.url, process.execArgv), {
      ...options,
      idleTimeoutMs: options.idleTimeoutMs ?? SOLVER_IDLE_TIMEOUT_MS,
      maxJobsPerChild: options.maxJobsPerChild ?? SOLVER_MAX_JOBS_PER_CHILD,
    });
  }
}

/**
 * Pool limits from CHIASMUS_SOLVER_JOB_TIMEOUT_MS (default 10 minutes, over
 * Z3's own 30 s default; raise it for solves that set a longer :timeout).
 * Unset or invalid keeps the default; over 2^31-1 ms it is capped there.
 */
export function solverPoolOptionsFromEnv(env: NodeJS.ProcessEnv): SolverChildPoolOptions {
  return { jobTimeoutMs: positiveInt(env.CHIASMUS_SOLVER_JOB_TIMEOUT_MS) };
}

const pools = new Map<SolverType, SolverChildPool>();

/** The process-wide pool for `type`, shared by every session in the process. */
export function getSolverChildPool(type: SolverType): SolverChildPool {
  let pool = pools.get(type);
  if (!pool) {
    pool = new SolverChildPool(type, solverPoolOptionsFromEnv(process.env));
    pools.set(type, pool);
  }
  return pool;
}

/**
 * Whether SolverSession runs `type` solves in a child process: unless
 * CHIASMUS_SOLVER_WORKER is 0, off or false, or the child entry is missing
 * (a bundler copied this module but not solver-child.js).
 */
export function solverChildEnabled(type: SolverType): boolean {
  return !switchedOff(process.env.CHIASMUS_SOLVER_WORKER) && getSolverChildPool(type).entryAvailable;
}

/** A Solver whose solves run in the shared child process for `type`. */
export function createChildSolver(type: SolverType): Solver {
  let disposed = false;
  const run = (input: SolverInput | PrologBatchInput, options?: SolveOptions): Promise<SolverResult[]> =>
    disposed
      ? Promise.resolve([{ status: "error", error: "Solver has been disposed" }])
      : getSolverChildPool(type).run({ input, signal: options?.signal });
  return {
    type,
    solve: async (input, options) => (await run(input, options))[0],
    ...(type === "prolog" ? { solveBatch: (input: PrologBatchInput, options?: SolveOptions) => run(input, options) } : {}),
    dispose() {
      disposed = true;
    },
  };
}

/**
 * Kill the solver children and refuse solves from then on; called on server
 * shutdown. The closed pools stay in place, so a solve arriving while the
 * server drains gets an error instead of starting a fresh child.
 */
export async function shutdownSolverChildren(): Promise<void> {
  await Promise.all((["z3", "prolog"] as const).map((type) => getSolverChildPool(type).close()));
}
