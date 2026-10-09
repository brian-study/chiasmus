import { randomUUID } from "node:crypto";
import { createZ3Solver } from "./z3-solver.js";
import { createPrologSolver } from "./prolog-solver.js";
import { createChildSolver, solverChildEnabled } from "./child-pool.js";
import type {
  PrologBatchInput,
  SolveOptions,
  Solver,
  SolverType,
  SolverInput,
  SolverResult,
} from "./types.js";

/**
 * A solver for the tools: its solves run in a child process per solver
 * (child-pool.ts), so an input that crashes a solver costs that solve, not
 * the process. With CHIASMUS_SOLVER_WORKER=0|off|false, or no child entry on
 * disk, they run in this process, where a crash is fatal to the module
 * (fatal.ts).
 */
export class SolverSession {
  readonly id: string;
  readonly solverType: SolverType;
  private solver: Solver;

  private constructor(id: string, solverType: SolverType, solver: Solver) {
    this.id = id;
    this.solverType = solverType;
    this.solver = solver;
  }

  static async create(type: SolverType): Promise<SolverSession> {
    const id = randomUUID();
    const solver = solverChildEnabled(type)
      ? createChildSolver(type)
      : type === "z3" ? await createZ3Solver() : createPrologSolver();
    return new SolverSession(id, type, solver);
  }

  async solve(input: SolverInput, options?: SolveOptions): Promise<SolverResult> {
    return this.solver.solve(input, options);
  }

  async solveBatch(input: PrologBatchInput, options?: SolveOptions): Promise<SolverResult[]> {
    if (!this.solver.solveBatch) {
      return [{ status: "error", error: "Batch solving is only supported by Prolog" }];
    }
    return this.solver.solveBatch(input, options);
  }

  dispose(): void {
    this.solver.dispose();
  }
}
