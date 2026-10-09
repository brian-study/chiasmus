import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createZ3Solver } from "../src/solvers/z3-solver.js";
import { setFatalSolverErrorHandler } from "../src/solvers/fatal.js";
import type { SolverResult } from "../src/solvers/types.js";

// The real z3-solver and prolog-wasm-full modules, no fakes: these check
// that a real crash reaches our code as a fatal error instead of being
// swallowed, which tests/solver-fatal.test.ts can only assume.

async function solveZ3(smtlib: string): Promise<SolverResult> {
  const solver = await createZ3Solver();
  try {
    return await solver.solve({ type: "z3", smtlib });
  } finally {
    solver.dispose();
  }
}

afterEach(() => {
  setFatalSolverErrorHandler(null);
});

describe("ordinary solver errors stay recoverable", () => {
  it("does not treat an error that echoes 'Aborted(' from user input as fatal", async () => {
    const handler = vi.fn();
    setFatalSolverErrorHandler(handler);

    // Model extraction fails on a function in the model, and its message
    // quotes the user's declaration.
    const result = await solveZ3(`(declare-fun |Aborted(| (Int) Int)
(assert (= (|Aborted(| 1) 2))`);
    const next = await solveZ3("(declare-const x Int) (assert (= x 3))");

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatch(/^Model extraction failed: Incorrect number of arguments to/);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(next).toEqual({ status: "sat", model: { x: "3" } });
  });
});

// Both modules marshal string arguments onto the Emscripten stack, so an
// oversized input overflows it and traps with "memory access out of bounds" —
// a real, fast and deterministic crash. If a dependency upgrade stops these
// inputs from trapping, these tests fail at the first status check; find
// another input that crashes the module rather than deleting them.
describe("real WASM crashes", () => {
  // A crash leaves the solver unusable for the rest of the process, so each
  // test loads its own copy of the solver modules, and its own SWI runtime:
  // prolog-wasm-full requires the Emscripten factory, which works once, so
  // its require cache entry goes too.
  beforeEach(() => {
    vi.resetModules();
    const swipl = fileURLToPath(new URL("../vendor/swipl-web.cjs", import.meta.resolve("prolog-wasm-full")));
    delete createRequire(import.meta.url).cache[swipl];
  });

  it("reports a Z3 trap, fails the queued solve, and fails fast afterwards", async () => {
    const fatal = await import("../src/solvers/fatal.js");
    const z3 = await import("../src/solvers/z3-solver.js");
    const handler = vi.fn();
    fatal.setFatalSolverErrorHandler(handler);
    const solve = async (smtlib: string) => {
      const solver = await z3.createZ3Solver();
      try {
        return await solver.solve({ type: "z3", smtlib });
      } finally {
        solver.dispose();
      }
    };

    // z3-solver copies the input onto a 20 MiB stack.
    const oversized = `; ${"x".repeat(24 * 1024 * 1024)}\n(declare-const x Int)`;
    const [crashed, queued] = await Promise.all([
      solve(oversized),
      solve("(declare-const x Int) (assert (= x 1))"),
    ]);
    const later = await solve("(declare-const x Int) (assert (= x 2))");

    expect(crashed).toEqual({ status: "error", error: "memory access out of bounds" });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toBe("z3");
    expect(handler.mock.calls[0][1]).toBeInstanceOf(WebAssembly.RuntimeError);
    for (const result of [queued, later]) {
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.error).toMatch(/unavailable.*restart the process/);
    }
  });

  it("reports a Prolog trap, stops the solve waiting on it, and fails fast afterwards", async () => {
    const fatal = await import("../src/solvers/fatal.js");
    const prolog = await import("../src/solvers/prolog-solver.js");
    const handler = vi.fn();
    fatal.setFatalSolverErrorHandler(handler);
    const solve = async (query: string) => {
      const solver = prolog.createPrologSolver();
      try {
        return await solver.solve({ type: "prolog", program: "p(1).", query });
      } finally {
        solver.dispose();
      }
    };

    // Queries of 1M characters still pass; 2M already trap.
    const oversized = `atom_length('${"a".repeat(4_000_000)}', L).`;
    const [crashed, waiting] = await Promise.all([solve(oversized), solve("p(X).")]);
    const later = await solve("p(X).");

    expect(crashed).toEqual({ status: "error", error: "memory access out of bounds" });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toBe("prolog");
    expect(handler.mock.calls[0][1]).toBeInstanceOf(WebAssembly.RuntimeError);
    for (const result of [waiting, later]) {
      expect(result.status).toBe("error");
      if (result.status === "error") expect(result.error).toMatch(/unavailable.*restart the process/);
    }
  });

  // halt/0,1 makes SWI call Emscripten's exit(), which ends the runtime and
  // throws an ExitStatus object, not a RuntimeError. Taken for an ordinary
  // error, the solve went on calling into the exited runtime and trapped, or,
  // from a directive, returned "consult failed: [object Object]" and left the
  // trap to the next solve.
  it.each([
    ["the query", "p(1).", "halt."],
    ["the query, through call/1", "p(1).", "G = halt, call(G)."],
    ["a directive", ":- halt.\np(1).", "p(X)."],
    ["a directive, with a status", ":- initialization(halt(3)).\np(1).", "p(X)."],
  ])("reports a halt from %s as fatal, without calling back into the exited runtime", async (_where, program, query) => {
    const fatal = await import("../src/solvers/fatal.js");
    const prolog = await import("../src/solvers/prolog-solver.js");
    const handler = vi.fn();
    fatal.setFatalSolverErrorHandler(handler);
    const solve = async (q: string) => {
      const solver = prolog.createPrologSolver();
      try {
        return await solver.solve({ type: "prolog", program, query: q });
      } finally {
        solver.dispose();
      }
    };

    const exitCode = process.exitCode;
    let halted: SolverResult;
    try {
      halted = await solve(query);
      // Emscripten's exit sets the host's exit code; a halt must not end
      // this process with it.
      await Promise.resolve();
      expect(process.exitCode).toBe(exitCode);
    } finally {
      process.exitCode = exitCode;
    }
    const later = await solve("p(X).");

    expect(halted.status).toBe("error");
    if (halted.status === "error") expect(halted.error).toMatch(/^Prolog runtime exited \(halt\), status \d+$/);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toBe("prolog");
    expect(handler.mock.calls[0][1]).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(later.status).toBe("error");
    if (later.status === "error") expect(later.error).toMatch(/unavailable.*restart the process/);
  });
});
