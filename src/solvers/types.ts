/** Identifies which solver engine to use */
export type SolverType = "z3" | "prolog";

/** Result of a solver execution */
export type SolverResult =
  | { status: "sat"; model: Record<string, string> }
  | { status: "unsat"; unsatCore?: string[] }
  | { status: "unknown" }
  | { status: "success"; answers: PrologAnswer[]; trace?: string[]; warnings?: string[] }
  | { status: "error"; error: string; warnings?: string[] };

/** A single Prolog query answer: variable bindings */
export interface PrologAnswer {
  bindings: Record<string, string>;
  formatted: string;
}

/** Common interface for all solver backends */
export interface Solver {
  readonly type: SolverType;

  /**
   * Execute a formal specification and return a structured result.
   * For Z3: input is SMT-LIB format.
   * For Prolog: input is { program, query }.
   */
  solve(input: SolverInput, options?: SolveOptions): Promise<SolverResult>;

  /** Execute several Prolog goals against one consulted program. */
  solveBatch?(input: PrologBatchInput, options?: SolveOptions): Promise<SolverResult[]>;

  /** Clean up any resources held by this solver instance */
  dispose(): void;
}

/** Per-call options of Solver.solve and solveBatch. */
export interface SolveOptions {
  /**
   * Aborting it stops the solve: dropped if still queued, its child process
   * killed if running. Only solvers that run in a child process
   * (createChildSolver, what SolverSession uses) can stop a running solve;
   * the in-process ones ignore it.
   */
  signal?: AbortSignal;
}

/** Input to a solver */
export type SolverInput =
  | { type: "z3"; smtlib: string }
  | {
      type: "prolog";
      program: string;
      query: string;
      explain?: boolean;
      /**
       * Override the default inference limit (100 000). Raise this for
       * analyses that walk large graphs via list-based reachability rules,
       * which are O(n²) per step. Lower it for adversarial input.
       */
      maxInferences?: number;
    };

/** Several goals that share one Prolog program and module lifecycle. */
export interface PrologBatchInput {
  type: "prolog";
  program: string;
  queries: string[];
  explain?: boolean;
  maxInferences?: number;
}
