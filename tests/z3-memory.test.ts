import { describe, it, expect } from "vitest";
import { createZ3Solver, z3AllocatedBytes } from "../src/solvers/z3-solver.js";
import type { SolverResult } from "../src/solvers/types.js";

// Each verify call creates and disposes one solver, as SolverSession does.
async function solveOnce(smtlib: string): Promise<SolverResult> {
  const solver = await createZ3Solver();
  try {
    return await solver.solve({ type: "z3", smtlib });
  } finally {
    solver.dispose();
  }
}

// One problem of each shape the daemon sees: sat with a model, unsat with a
// core, datatypes, parse errors, and a define-fun model extraction failure.
function problem(i: number): string {
  switch (i % 5) {
    case 0:
      return `(declare-const x Int) (declare-const y Int) (assert (> x ${i})) (assert (< y x))`;
    case 1:
      return `(declare-const p Bool) (assert (! p :named on_${i})) (assert (! (not p) :named off_${i}))`;
    case 2:
      return `(declare-datatype Color ((red) (green) (c${i}))) (declare-const c Color) (assert (= c c${i}))`;
    case 3:
      return `(declare-const x Int) (assert (> x "not a number ${i}"))`;
    default:
      return `(define-fun f${i} ((a Int)) Int (* 2 a)) (declare-const y Int) (assert (= y (f${i} ${i})))`;
  }
}

describe("Z3 solver memory", () => {
  // The daemon hung after ~239 verify calls: every call created a Z3 context
  // that was never freed (~8-10 MB each) until the fixed 2 GiB WASM heap ran
  // out and Emscripten aborted.
  it("returns Z3's WASM allocations to baseline after each solve", async () => {
    for (let i = 0; i < 5; i++) await solveOnce(problem(i));
    const before = await z3AllocatedBytes();

    for (let i = 0; i < 40; i++) await solveOnce(problem(i));

    const growth = (await z3AllocatedBytes()) - before;
    // Leaking one context per call grows by ~350 MB here.
    expect(growth).toBeLessThan(1_000_000);
  });

  it.runIf(process.env.CHIASMUS_Z3_SOAK)(
    "stays flat over a 2000-call soak (CHIASMUS_Z3_SOAK=1)",
    async () => {
      for (let i = 0; i < 5; i++) await solveOnce(problem(i));
      const before = await z3AllocatedBytes();
      for (let i = 0; i < 2000; i++) await solveOnce(problem(i));
      expect((await z3AllocatedBytes()) - before).toBeLessThan(1_000_000);
    },
    300_000,
  );
});
