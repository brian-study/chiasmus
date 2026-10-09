/**
 * Child-process entry for solves (see child-pool.ts). Runs each job with the
 * in-process solver and reports a fatal WASM error with its result; the
 * parent then replaces this process.
 */

import { serveJobs } from "../child/serve.js";
import { setFatalSolverErrorHandler } from "./fatal.js";
import { capResults, type SolverJobMessage } from "./child-pool.js";
import type { PrologBatchInput, Solver, SolverInput, SolverResult, SolverType } from "./types.js";

// Recorded, not acted on: the job's result carries it to the parent, which
// kills this process. The solver answers whatever else arrives with an error.
let fatal: string | undefined;
setFatalSolverErrorHandler((_solver, error) => {
  fatal ??= error.message;
});

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// An abort on one of Z3's pthreads (a check that runs out of heap) runs no
// onAbort hook: Emscripten rethrows the thread's error here as an uncaught
// exception, and the solve waiting on that thread would wait forever. Any
// uncaught exception leaves this process broken, so it ends the running job,
// flagged fatal: the parent replaces this process, and the client gets the
// error rather than a bare exit code.
let failRunning: ((e: unknown) => void) | null = null;
process.on("uncaughtException", (e) => {
  if (!failRunning) {
    console.error(e);
    process.exit(1);
  }
  failRunning(e);
});

/** Each child runs one solver: the other's module is never loaded. */
async function createSolver(type: SolverType): Promise<Solver> {
  if (type === "z3") return (await import("./z3-solver.js")).createZ3Solver();
  return (await import("./prolog-solver.js")).createPrologSolver();
}

async function solve(type: SolverType, input: SolverInput | PrologBatchInput): Promise<SolverResult[]> {
  const solver = await createSolver(type);
  try {
    if (!("queries" in input)) return [await solver.solve(input)];
    if (solver.solveBatch) return await solver.solveBatch(input);
    return [{ status: "error", error: "Batch solving is only supported by Prolog" }];
  } finally {
    solver.dispose();
  }
}

serveJobs<SolverJobMessage, SolverResult[]>(async ({ solver: type, input }) => {
  let result: SolverResult[];
  try {
    result = await new Promise<SolverResult[]>((resolve, reject) => {
      failRunning = (e) => {
        fatal ??= messageOf(e);
        reject(e);
      };
      solve(type, input).then(resolve, reject);
    });
  } catch (e) {
    result = [{ status: "error", error: messageOf(e) }];
  } finally {
    failRunning = null;
  }
  return { result: capResults(result), fatal };
});
