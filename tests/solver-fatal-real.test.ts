import { describe, it, expect, vi, afterEach } from "vitest";
import { createZ3Solver } from "../src/solvers/z3-solver.js";
import { setFatalSolverErrorHandler } from "../src/solvers/fatal.js";
import type { SolverResult } from "../src/solvers/types.js";

// The real z3-solver and prolog-wasm-full modules, no fakes.

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
