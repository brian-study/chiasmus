import { describe, it, expect } from "vitest";
import { createZ3Solver } from "../src/solvers/z3-solver.js";
import type { SolverResult } from "../src/solvers/types.js";

async function solveOnce(smtlib: string): Promise<SolverResult> {
  const solver = await createZ3Solver();
  try {
    return await solver.solve({ type: "z3", smtlib });
  } finally {
    solver.dispose();
  }
}

// Every verify call must behave as if it ran in a fresh process. Z3 keeps
// some declarations at context level (named assertions, define-fun), so these
// fail if solves ever share a context.
describe("Z3 solves are isolated from each other", () => {
  it("lets consecutive calls declare the same name with different sorts", async () => {
    const asInt = await solveOnce(`(declare-const x Int) (assert (= x 5))`);
    const asBool = await solveOnce(`(declare-const x Bool) (assert x)`);
    const asReal = await solveOnce(`(declare-const x Real) (assert (= x 2.5))`);

    expect(asInt).toEqual({ status: "sat", model: { x: "5" } });
    expect(asBool).toEqual({ status: "sat", model: { x: "true" } });
    expect(asReal).toEqual({ status: "sat", model: { x: "(/ 5.0 2.0)" } });
  });

  it("lets consecutive calls redeclare a datatype with different constructors", async () => {
    const first = await solveOnce(
      `(declare-datatype Color ((red) (green))) (declare-const c Color) (assert (not (= c red)))`,
    );
    const second = await solveOnce(
      `(declare-datatypes ((Color 0)) (((blue) (pink)))) (declare-const c Color) (assert (not (= c blue)))`,
    );

    expect(first).toEqual({ status: "sat", model: { c: "green" } });
    expect(second).toEqual({ status: "sat", model: { c: "pink" } });
  });

  it("keeps named assertions out of later models", async () => {
    const named = await solveOnce(
      `(declare-const a Int) (assert (! (> a 10) :named big)) (assert (! (< a 5) :named small))`,
    );
    const later = await solveOnce(`(declare-const s String) (assert (= (str.len s) 3))`);

    expect(named.status).toBe("unsat");
    if (named.status === "unsat") {
      expect(named.unsatCore?.sort()).toEqual(["big", "small"]);
    }
    expect(later.status).toBe("sat");
    if (later.status === "sat") {
      expect(Object.keys(later.model)).toEqual(["s"]);
    }
  });

  it("does not let one call's define-fun break model extraction in the next", async () => {
    const withFun = await solveOnce(
      `(define-fun dbl ((v Int)) Int (* 2 v)) (declare-const y Int) (assert (= y (dbl 4)))`,
    );
    const named = await solveOnce(
      `(declare-const a Int) (assert (! (> a 1) :named lo)) (assert (! (< a 5) :named hi))`,
    );

    expect(withFun).toEqual({ status: "sat", model: { y: "8" } });
    // A call's own named assertions are part of its model; dbl is not.
    expect(named).toEqual({
      status: "sat",
      model: { lo: "(_ lo 0)", hi: "(_ hi 0)", a: "2" },
    });
  });

  it("recovers from a parse error and a timeout in earlier calls", async () => {
    const parseError = await solveOnce(`(declare-const x Int) (assert (> x "nope"))`);
    // Sum of three cubes = 42: hopeless for Z3, so it stops at the timeout.
    const timedOut = await solveOnce(
      `(set-option :timeout 100)
       (declare-const x Int) (declare-const y Int) (declare-const z Int)
       (assert (= (+ (* x x x) (* y y y) (* z z z)) 42))`,
    );
    const after = await solveOnce(`(declare-const x Int) (assert (= x 3))`);

    expect(parseError.status).toBe("error");
    if (parseError.status === "error") {
      expect(parseError.error).toMatch(/Sort mismatch/);
    }
    expect(timedOut).toEqual({ status: "unknown" });
    expect(after).toEqual({ status: "sat", model: { x: "3" } });
  });

  it("returns the right model for each of several concurrent solves", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        solveOnce(`(declare-const x Int) (assert (= x ${i}))`),
      ),
    );

    results.forEach((result, i) => {
      expect(result).toEqual({ status: "sat", model: { x: String(i) } });
    });
  });
});
