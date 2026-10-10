import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChiasmusServer } from "../src/mcp-server.js";
import { SolverSession } from "../src/solvers/session.js";
import { setFatalSolverErrorHandler } from "../src/solvers/fatal.js";
import { MAX_RESULT_CHARS, SolverChildPool, capResults, getSolverChildPool, shutdownSolverChildren } from "../src/solvers/child-pool.js";
import type { SolverInput, SolverResult } from "../src/solvers/types.js";

// SolverSession runs each solve in a child process, one per solver, so a
// solver crash costs the solve that caused it, never this process. These
// use the real solver modules: the crashing inputs are the ones that trap
// them in-process (tests/solver-fatal-real.test.ts).

const PROLOG_TRAP_QUERY = `atom_length('${"a".repeat(4_000_000)}', L).`;
const Z3_TRAP = `; ${"x".repeat(24 * 1024 * 1024)}\n(declare-const x Int)`;

/** Pigeonhole: n+1 pigeons, n holes. Unsat, and at n=12 it takes Z3 minutes. */
function pigeonhole(n: number): string {
  const lines = ["(set-option :timeout 600000)"];
  for (let i = 0; i <= n; i++) for (let j = 0; j < n; j++) lines.push(`(declare-const p${i}_${j} Bool)`);
  for (let i = 0; i <= n; i++) {
    lines.push(`(assert (or ${Array.from({ length: n }, (_, j) => `p${i}_${j}`).join(" ")}))`);
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i <= n; i++) {
      for (let k = i + 1; k <= n; k++) lines.push(`(assert (not (and p${i}_${j} p${k}_${j})))`);
    }
  }
  return lines.join("\n");
}
const LONG_Z3 = pigeonhole(12);

async function solve(input: SolverInput, signal?: AbortSignal): Promise<SolverResult> {
  const session = await SolverSession.create(input.type);
  try {
    return await session.solve(input, { signal });
  } finally {
    session.dispose();
  }
}

const prolog = (query: string, program = "p(1).") => solve({ type: "prolog", program, query });
const z3 = (smtlib: string, signal?: AbortSignal) => solve({ type: "z3", smtlib }, signal);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let pools: SolverChildPool[] = [];

afterEach(async () => {
  setFatalSolverErrorHandler(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(pools.map((p) => p.close()));
  pools = [];
});

afterAll(async () => {
  await shutdownSolverChildren();
});

describe("SolverSession in a solver child process", () => {
  it("answers a Prolog trap with an error, and the next solve gets a fresh child", async () => {
    const handler = vi.fn();
    setFatalSolverErrorHandler(handler);

    const before = await prolog("p(X).");
    const crashedPid = getSolverChildPool("prolog").pid;
    const trapped = await prolog(PROLOG_TRAP_QUERY);
    const after = await prolog("p(X).");

    expect(before.status).toBe("success");
    expect(trapped).toEqual({ status: "error", error: "memory access out of bounds" });
    expect(after).toEqual({ status: "success", answers: [{ bindings: { X: "1" }, formatted: "X = 1" }] });
    expect(getSolverChildPool("prolog").pid).not.toBe(crashedPid);
    await vi.waitFor(() => expect(alive(crashedPid!)).toBe(false), { timeout: 10_000, interval: 50 });
    // The crash happened in the child: this process's modules never saw it.
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["a query", "p(1).", "halt."],
    ["a directive", ":- halt.\np(1).", "p(X)."],
  ])("answers a halt from %s with an error, and goes on solving", async (_where, program, query) => {
    const halted = await prolog(query, program);
    const after = await prolog("p(X).");

    expect(halted.status).toBe("error");
    if (halted.status === "error") expect(halted.error).toMatch(/^Prolog runtime exited \(halt\)/);
    expect(after.status).toBe("success");
  });

  it("fails only the Z3 solve that traps: the one queued behind it runs in a fresh child", async () => {
    const [crashed, queued] = await Promise.all([
      z3(Z3_TRAP),
      z3("(declare-const x Int) (assert (= x 1))"),
    ]);
    const later = await z3("(declare-const x Int) (assert (= x 2))");

    expect(crashed).toEqual({ status: "error", error: "memory access out of bounds" });
    expect(queued).toEqual({ status: "sat", model: { x: "1" } });
    expect(later).toEqual({ status: "sat", model: { x: "2" } });
  }, 60_000);

  it("runs a Prolog batch against one consulted program", async () => {
    const session = await SolverSession.create("prolog");
    try {
      const results = await session.solveBatch({
        type: "prolog",
        program: "p(1). p(2).",
        queries: ["p(1).", "nope(", "p(X)."],
      });
      expect(results.map((r) => r.status)).toEqual(["success", "error", "success"]);
    } finally {
      session.dispose();
    }
  });

  it("runs Z3 and Prolog in separate children, so one doesn't wait behind the other", async () => {
    const controller = new AbortController();
    const long = z3(LONG_Z3, controller.signal);
    try {
      await vi.waitFor(() => expect(getSolverChildPool("z3").pid).toBeDefined(), { timeout: 10_000, interval: 20 });
      const started = Date.now();
      expect((await prolog("p(X).")).status).toBe("success");
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(getSolverChildPool("prolog").pid).not.toBe(getSolverChildPool("z3").pid);
    } finally {
      controller.abort();
      await long;
    }
  }, 60_000);

  it("kills a running solve when its signal aborts, and the next solve runs", async () => {
    const controller = new AbortController();
    const long = z3(LONG_Z3, controller.signal);
    const pid = await vi.waitFor(() => {
      const p = getSolverChildPool("z3").pid;
      expect(p).toBeDefined();
      return p!;
    }, { timeout: 10_000, interval: 20 });
    // Let the check start.
    await new Promise((r) => setTimeout(r, 1_000));
    controller.abort();

    expect(await long).toEqual({ status: "error", error: "z3 solve was cancelled by the client" });
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000, interval: 50 });
    expect(await z3("(declare-const x Int) (assert (= x 3))")).toEqual({ status: "sat", model: { x: "3" } });
  }, 60_000);

  it("kills a solve that runs past the job timeout", async () => {
    // The timeout covers the child's cold start too (about a second for Z3).
    const pool = new SolverChildPool("z3", { jobTimeoutMs: 8_000 });
    pools.push(pool);

    const [timedOut] = await pool.run({ input: { type: "z3", smtlib: LONG_Z3 } });
    const [next] = await pool.run({ input: { type: "z3", smtlib: "(declare-const x Int) (assert (= x 4))" } });

    expect(timedOut).toEqual({
      status: "error",
      error: "z3 solve exceeded 8000ms and was aborted; the z3 solver worker was restarted",
    });
    expect(next).toEqual({ status: "sat", model: { x: "4" } });
  }, 60_000);

  it("reports a child killed mid-solve as a crash", async () => {
    const pool = new SolverChildPool("z3");
    pools.push(pool);

    const running = pool.run({ input: { type: "z3", smtlib: LONG_Z3 } });
    const pid = await vi.waitFor(() => {
      expect(pool.pid).toBeDefined();
      return pool.pid!;
    }, { timeout: 10_000, interval: 20 });
    process.kill(pid, "SIGKILL");

    expect(await running).toEqual([{
      status: "error",
      error: "z3 solver worker crashed while running z3 solve: killed by SIGKILL",
    }]);
  }, 60_000);

  // A short query can produce an answer of any size: 100M characters made
  // the server hold 1.8 GB and stall for 0.7 s to pass on a 200 MB response
  // no client can use.
  it("refuses a result over the size cap instead of sending it to the server", async () => {
    const big = `format(atom(A), '~*c', [${11 * 1024 * 1024}, 97]).`;
    const tooBig = await prolog(big);
    const after = await prolog("p(X).");

    expect(tooBig.status).toBe("error");
    if (tooBig.status === "error") {
      expect(tooBig.error).toMatch(/^The result is \d+ characters of JSON, over the 10485760 cap/);
    }
    expect(after.status).toBe("success");
  }, 60_000);

  it("drops only the oversized results of a batch, so the others still arrive", async () => {
    const session = await SolverSession.create("prolog");
    try {
      const results = await session.solveBatch({
        type: "prolog",
        program: "p(1).",
        queries: ["p(X).", `format(atom(A), '~*c', [${11 * 1024 * 1024}, 97]).`, "p(Y)."],
      });
      expect(results.map((r) => r.status)).toEqual(["success", "error", "success"]);
    } finally {
      session.dispose();
    }
  }, 60_000);

  it("counts a result JSON can't serialize as over the cap, and keeps the others", () => {
    const ok: SolverResult = { status: "success", answers: [{ bindings: { X: "1" }, formatted: "X = 1" }] };
    const unserializable = { status: "sat", model: { x: 1n } } as unknown as SolverResult;
    const big: SolverResult = { status: "sat", model: { x: "1".repeat(MAX_RESULT_CHARS) } };

    const capped = capResults([ok, unserializable, ok, big, ok]);

    expect(capped.map((r) => r.status)).toEqual(["success", "error", "success", "error", "success"]);
    expect(capped[1]).toMatchObject({ error: expect.stringMatching(/^The result is more than 512M characters/) });
  });

  it("says so when a result under the cap is cut because the batch as a whole is over it", () => {
    const smaller: SolverResult = { status: "sat", model: { x: "1".repeat(MAX_RESULT_CHARS * 0.55) } };
    const larger: SolverResult = { status: "sat", model: { x: "1".repeat(MAX_RESULT_CHARS * 0.6) } };

    const capped = capResults([smaller, larger]);

    expect(capped[0]).toBe(smaller);
    expect(capped[1]).toMatchObject({
      status: "error",
      error: expect.stringMatching(/^The batch's results are \d+ characters of JSON together, over the 10485760 cap; this one \(\d+ characters\) was cut/),
    });
  });

  it("answers a batch whose results can't fit even as errors with one error, quickly", () => {
    const one: SolverResult = { status: "success", answers: [{ bindings: { X: "x".repeat(100) }, formatted: "X = x" }] };
    const results = Array.from({ length: 90_000 }, () => one);

    const started = performance.now();
    const capped = capResults(results);

    expect(performance.now() - started).toBeLessThan(2_000);
    expect(capped).toEqual([{
      status: "error",
      error: expect.stringMatching(/^The 90000 results are \d+ characters of JSON, over the 10485760 cap/),
    }]);
    expect(JSON.stringify(capped).length).toBeLessThan(MAX_RESULT_CHARS);
  });

  it("runs solves in this process when CHIASMUS_SOLVER_WORKER=off", async () => {
    const run = vi.spyOn(SolverChildPool.prototype, "run");
    expect((await prolog("p(X).")).status).toBe("success");
    expect(run).toHaveBeenCalledOnce();

    vi.stubEnv("CHIASMUS_SOLVER_WORKER", "off");
    expect((await prolog("p(X).")).status).toBe("success");
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("chiasmus_verify", () => {
  it("kills the solver child when the client cancels the call", async () => {
    const home = await mkdtemp(join(tmpdir(), "chiasmus-verify-cancel-"));
    const { server, library } = await createChiasmusServer(home, null, null);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "verify-cancel-test", version: "0.0.1" });
    await client.connect(clientTransport);
    try {
      const controller = new AbortController();
      const call = client.callTool(
        { name: "chiasmus_verify", arguments: { solver: "z3", input: LONG_Z3 } },
        undefined,
        { signal: controller.signal, timeout: 120_000 },
      );
      const pid = await vi.waitFor(() => {
        const p = getSolverChildPool("z3").pid;
        expect(p).toBeDefined();
        return p!;
      }, { timeout: 10_000, interval: 20 });
      await new Promise((r) => setTimeout(r, 1_000));
      controller.abort();

      await expect(call).rejects.toThrow();
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000, interval: 50 });
      const next = await client.callTool({
        name: "chiasmus_verify",
        arguments: { solver: "z3", input: "(declare-const x Int) (assert (= x 5))" },
      });
      expect(JSON.parse((next.content as Array<{ text: string }>)[0].text)).toEqual({ status: "sat", model: { x: "5" } });
    } finally {
      await client.close();
      await server.close();
      library.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
