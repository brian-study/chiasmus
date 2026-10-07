import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  GraphWorkerPool,
  exitAfterStoppingGraphWorkers,
  poolOptionsFromEnv,
  runGraphTool,
  shutdownGraphWorkers,
  workerEntryFor,
  type GraphWorkerPoolOptions,
} from "../../src/graph/worker-pool.js";

const FAKE_WORKER = new URL("./fixtures/fake-graph-worker.mjs", import.meta.url);

let pools: GraphWorkerPool[] = [];

function makePool(opts: GraphWorkerPoolOptions = {}): GraphWorkerPool {
  const pool = new GraphWorkerPool({ workerUrl: FAKE_WORKER, execArgv: [], cancelGraceMs: 300, ...opts });
  pools.push(pool);
  return pool;
}

async function run(pool: GraphWorkerPool, args: Record<string, unknown>): Promise<any> {
  const r = await pool.run({ tool: "chiasmus_graph", args });
  return JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
}

afterEach(async () => {
  await Promise.all(pools.map((p) => p.close()));
  pools = [];
});

describe("GraphWorkerPool", () => {
  it("reuses one persistent worker across jobs", async () => {
    const pool = makePool();
    const a = await run(pool, { mode: "ok" });
    const b = await run(pool, { mode: "ok" });
    const c = await run(pool, { mode: "ok" });
    expect(b.threadId).toBe(a.threadId);
    expect(c.threadId).toBe(a.threadId);
    expect([a.jobs, b.jobs, c.jobs]).toEqual([1, 2, 3]);
  });

  it("forwards the job's tool and adapter-discovery flag", async () => {
    const pool = makePool();
    const r = await pool.run({ tool: "chiasmus_map", args: { mode: "ok" }, discoverAdapters: true });
    const out = JSON.parse((r.content as Array<{ text: string }>)[0].text);
    expect(out).toMatchObject({ tool: "chiasmus_map", discoverAdapters: true });
  });

  it("runs jobs one at a time, in order", async () => {
    const pool = makePool();
    const [a, b] = await Promise.all([
      run(pool, { mode: "sleep", ms: 150 }),
      run(pool, { mode: "sleep", ms: 10 }),
    ]);
    expect(b.threadId).toBe(a.threadId);
    expect(b.startedAt).toBeGreaterThanOrEqual(a.endedAt);
  });

  it("returns an error result and starts a fresh worker after an uncaught crash", async () => {
    const pool = makePool();
    const before = await run(pool, { mode: "ok" });
    const crashed = await run(pool, { mode: "crash" });
    expect(crashed.error).toMatch(/^graph worker crashed while running chiasmus_graph: .*boom/);
    const after = await run(pool, { mode: "ok" });
    expect(after.threadId).not.toBe(before.threadId);
    expect(after.jobs).toBe(1);
  });

  it("recovers from the worker exiting mid-job", async () => {
    const pool = makePool();
    const before = await run(pool, { mode: "ok" });
    const exited = await run(pool, { mode: "exit" });
    expect(exited.error).toMatch(/^graph worker crashed while running chiasmus_graph: .*exit code 3/);
    const after = await run(pool, { mode: "ok" });
    expect(after.threadId).not.toBe(before.threadId);
  });

  it("never reuses a worker that reported a fatal WASM error", async () => {
    const pool = makePool();
    const poisoned = await run(pool, { mode: "fatal" });
    // The job's own result is returned unchanged...
    expect(poisoned.error).toBe("memory access out of bounds");
    // ...but the next job must not land on the poisoned instance.
    const next = await run(pool, { mode: "ok" });
    expect(next.threadId).not.toBe(poisoned.threadId);
    expect(next.jobs).toBe(1);
  });

  it("recycles the worker after maxJobsPerWorker jobs", async () => {
    const pool = makePool({ maxJobsPerWorker: 2 });
    const a = await run(pool, { mode: "ok" });
    const b = await run(pool, { mode: "ok" });
    const c = await run(pool, { mode: "ok" });
    expect(b.threadId).toBe(a.threadId);
    expect(c.threadId).not.toBe(a.threadId);
    expect(c.jobs).toBe(1);
  });

  it("recycles the worker when the RSS growth it reports exceeds the cap", async () => {
    const pool = makePool({ maxRssGrowthBytes: 1_000 });
    const big = await run(pool, { mode: "memory", bytes: 5_000 });
    const next = await run(pool, { mode: "ok" });
    expect(next.threadId).not.toBe(big.threadId);
  });

  it("judges memory by RSS growth since the worker started, not absolute process RSS", async () => {
    // Memory a retired worker freed often stays in the process (allocator
    // arenas). Judged on absolute RSS, every later job — tiny ones included —
    // would replace the fresh worker again, until the process restarts.
    const pool = makePool({ maxRssGrowthBytes: 1_000 });
    const big = await run(pool, { mode: "memory", startBytes: 0, bytes: 5_000 });
    const small = await run(pool, { mode: "memory", startBytes: 5_000, bytes: 5_200 });
    const next = await run(pool, { mode: "ok" });
    expect(small.threadId).not.toBe(big.threadId);
    expect(next.threadId).toBe(small.threadId);
  });

  it("turns a resourceLimits overrun into an error result and a fresh worker", async () => {
    const pool = makePool({ resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 8 } });
    const before = await run(pool, { mode: "ok" });
    const oom = await run(pool, { mode: "oom" });
    expect(oom.error).toMatch(/^graph worker crashed while running chiasmus_graph: .*(memory|ERR_WORKER_OUT_OF_MEMORY)/i);
    const after = await run(pool, { mode: "ok" });
    expect(after.threadId).not.toBe(before.threadId);
  }, 30_000);

  it("aborts a job that exceeds the timeout and replaces the worker", async () => {
    const pool = makePool({ jobTimeoutMs: 300 });
    const before = await run(pool, { mode: "ok" });
    const hung = await run(pool, { mode: "hang" });
    expect(hung.error).toBe("chiasmus_graph exceeded 300ms and was aborted; the graph worker was restarted");
    const after = await run(pool, { mode: "ok" });
    expect(after.threadId).not.toBe(before.threadId);
  });

  it("bounds the queue and rejects excess jobs immediately", async () => {
    const pool = makePool({ maxQueue: 1 });
    const settled: string[] = [];
    const running = run(pool, { mode: "sleep", ms: 200 }).then((r) => (settled.push("running"), r));
    const queued = run(pool, { mode: "ok" }).then((r) => (settled.push("queued"), r));
    const rejected = await run(pool, { mode: "ok" }).then((r) => (settled.push("rejected"), r));
    expect(rejected.error).toBe("graph worker queue is full (1 jobs waiting); retry later");
    expect((await running).mode).toBe("sleep");
    expect((await queued).mode).toBe("ok");
    // Rejected without waiting for the running job.
    expect(settled).toEqual(["rejected", "running", "queued"]);
  });

  it("drops a queued job whose request was cancelled, without running it", async () => {
    const pool = makePool();
    const running = run(pool, { mode: "sleep", ms: 200 });
    const ac = new AbortController();
    const cancelled = pool.run({ tool: "chiasmus_map", args: { mode: "ok" }, signal: ac.signal });
    ac.abort();
    const r = JSON.parse((await cancelled).content[0].text as string);
    expect(r.error).toBe("chiasmus_map was cancelled by the client");
    await running;
    // The cancelled job never reached the worker.
    expect((await run(pool, { mode: "ok" })).jobs).toBe(2);
  });

  it("stops a running job whose request was cancelled and moves on", async () => {
    const pool = makePool();
    const before = await run(pool, { mode: "ok" });
    const ac = new AbortController();
    const job = pool.run({ tool: "chiasmus_graph", args: { mode: "spin-until-cancelled" }, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    const settled = await Promise.race([job, new Promise((r) => setTimeout(() => r("still running"), 5_000))]);
    expect(settled).not.toBe("still running");
    expect(JSON.parse((settled as any).content[0].text).error).toBe("chiasmus_graph was cancelled by the client");
    const after = await run(pool, { mode: "ok" });
    expect(after.threadId).not.toBe(before.threadId);
  });

  it("refuses a job whose request was already cancelled", async () => {
    const pool = makePool();
    const r = await pool.run({ tool: "chiasmus_graph", args: { mode: "ok" }, signal: AbortSignal.abort() });
    expect(JSON.parse((r.content as Array<{ text: string }>)[0].text).error).toBe("chiasmus_graph was cancelled by the client");
  });

  it("releases an idle worker after idleTimeoutMs", async () => {
    const pool = makePool({ idleTimeoutMs: 100 });
    const a = await run(pool, { mode: "ok" });
    await new Promise((r) => setTimeout(r, 400));
    const b = await run(pool, { mode: "ok" });
    expect(b.threadId).not.toBe(a.threadId);
  });

  it("shares the parent's environment live", async () => {
    const pool = makePool();
    await run(pool, { mode: "ok" });
    process.env.CHIASMUS_POOL_TEST_VAR = "late";
    try {
      expect((await run(pool, { mode: "env", name: "CHIASMUS_POOL_TEST_VAR" })).value).toBe("late");
    } finally {
      delete process.env.CHIASMUS_POOL_TEST_VAR;
    }
  });

  it("fails pending and future jobs on close", async () => {
    const pool = makePool();
    const running = run(pool, { mode: "sleep", ms: 5_000 });
    const queued = run(pool, { mode: "ok" });
    await new Promise((r) => setTimeout(r, 50));
    await pool.close();
    expect((await running).error).toBe("graph worker pool is shut down");
    expect((await queued).error).toBe("graph worker pool is shut down");
    expect((await run(pool, { mode: "ok" })).error).toBe("graph worker pool is shut down");
  });

  it("retires a busy worker cooperatively, without waiting out the grace period", async () => {
    const pool = makePool({ cancelGraceMs: 20_000 });
    const job = run(pool, { mode: "spin-until-cancelled" });
    await new Promise((r) => setTimeout(r, 100));
    const t0 = performance.now();
    await pool.close();
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect((await job).error).toBe("graph worker pool is shut down");
  });

  it("waits on close for a worker still retiring after a timeout", async () => {
    const pool = makePool({ jobTimeoutMs: 300, cancelGraceMs: 2_000 });
    const hung = await run(pool, { mode: "hang" });
    expect(hung.error).toMatch(/exceeded 300ms/);
    // The timed-out worker ignores the cancel flag; it only stops when the
    // grace period ends in terminate(). close() must not return before that,
    // or a shutdown would exit the process under a running worker.
    const t0 = performance.now();
    await pool.close();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(1_000);
  });

  it("terminates a worker that ignores the cancel request after the grace period", async () => {
    const pool = makePool({ cancelGraceMs: 200 });
    const job = run(pool, { mode: "hang" });
    await new Promise((r) => setTimeout(r, 100));
    const t0 = performance.now();
    await pool.close();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(150);
    expect((await job).error).toBe("graph worker pool is shut down");
  });

  it("reports a worker that cannot start as an error result", async () => {
    const pool = makePool({ workerUrl: new URL("./fixtures/does-not-exist.mjs", import.meta.url) });
    const r = await run(pool, { mode: "ok" });
    expect(r.error).toMatch(/^graph worker crashed while running chiasmus_graph: /);
  });

  it("resolves with an error result when the Worker constructor throws", async () => {
    // Node rejects per-process flags in an explicit worker execArgv, synchronously.
    const pool = makePool({ execArgv: ["--max-old-space-size=64"] });
    const settled = await Promise.allSettled([run(pool, { mode: "ok" }), run(pool, { mode: "ok" })]);
    for (const s of settled) {
      expect(s.status).toBe("fulfilled");
      if (s.status === "fulfilled") {
        expect(s.value.error).toMatch(/^graph worker could not start for chiasmus_graph: .*--max-old-space-size/);
      }
    }
  });

  it("survives the Worker constructor throwing while replacing a worker after a job", async () => {
    const pool = makePool({ maxJobsPerWorker: 1 });
    const first = run(pool, { mode: "sleep", ms: 100 });
    // The replacement spawned from the result listener can no longer start.
    (pool as unknown as { execArgv: string[] }).execArgv = ["--max-old-space-size=64"];
    const queued = run(pool, { mode: "ok" });
    expect((await first).mode).toBe("sleep");
    expect((await queued).error).toMatch(/^graph worker could not start for chiasmus_graph: /);
    (pool as unknown as { execArgv: string[] }).execArgv = [];
    expect((await run(pool, { mode: "ok" })).jobs).toBe(1);
  });
});

describe("workerEntryFor", () => {
  it("runs the compiled sibling graph-worker.js from dist with inherited flags", () => {
    const entry = workerEntryFor("file:///pkg/dist/graph/worker-pool.js", ["--enable-source-maps"]);
    expect(entry.url.href).toBe("file:///pkg/dist/graph/graph-worker.js");
    expect(entry.execArgv).toBeUndefined();
  });

  it("runs the .ts worker through tsx when loaded from source", () => {
    const entry = workerEntryFor("file:///pkg/src/graph/worker-pool.ts", ["--conditions", "node"]);
    expect(entry.url.href).toBe("file:///pkg/src/graph/graph-worker.ts");
    expect(entry.execArgv).toEqual(["--conditions", "node", "--import", "tsx"]);
  });

  it("forwards only loader flags to a source worker (others make new Worker() throw)", () => {
    const parent = [
      "--max-old-space-size=8192", "--expose-gc", "--title=chiasmus", "--experimental-import-meta-resolve",
      "--require", "/pkg/suppress-warnings.cjs", "--conditions", "node", "-C", "development",
      "--import=file:///pkg/hook.mjs",
    ];
    expect(workerEntryFor("file:///pkg/src/graph/worker-pool.ts", parent).execArgv).toEqual([
      "--require", "/pkg/suppress-warnings.cjs", "--conditions", "node", "-C", "development",
      "--import=file:///pkg/hook.mjs", "--import", "tsx",
    ]);
  });

  it("does not register tsx twice under the tsx CLI", () => {
    const cli = ["--require", "/pkg/node_modules/tsx/dist/preflight.cjs", "--import", "file:///pkg/node_modules/tsx/dist/loader.mjs"];
    expect(workerEntryFor("file:///pkg/src/graph/worker-pool.ts", cli).execArgv).toEqual(cli);
    // A path that merely contains "tsx" (pnpm store dir names) is not the loader.
    const vitest = ["--require", "/pkg/node_modules/.pnpm/vitest@4_tsx@4.23.13_/node_modules/vitest/x.cjs"];
    expect(workerEntryFor("file:///pkg/src/graph/worker-pool.ts", vitest).execArgv).toEqual([...vitest, "--import", "tsx"]);
  });

  it("points at a worker source that exists (tsc emits it beside worker-pool.js)", () => {
    const entry = workerEntryFor(new URL("../../src/graph/worker-pool.ts", import.meta.url).href, []);
    expect(existsSync(fileURLToPath(entry.url))).toBe(true);
  });
});

describe("runGraphTool", () => {
  it("runs inline when CHIASMUS_GRAPH_WORKER=off", async () => {
    const prev = process.env.CHIASMUS_GRAPH_WORKER;
    process.env.CHIASMUS_GRAPH_WORKER = "off";
    try {
      const r = await runGraphTool({ tool: "chiasmus_graph", args: { files: [], analysis: "nope" } });
      const text = (r.content as Array<{ text: string }>)[0].text;
      expect(JSON.parse(text).error).toMatch(/^Unknown analysis: nope/);
    } finally {
      if (prev === undefined) delete process.env.CHIASMUS_GRAPH_WORKER;
      else process.env.CHIASMUS_GRAPH_WORKER = prev;
    }
  });
});

describe("poolOptionsFromEnv", () => {
  it("reads the worker heap limit and the job timeout", () => {
    expect(poolOptionsFromEnv({ CHIASMUS_GRAPH_WORKER_HEAP_MB: "512", CHIASMUS_GRAPH_JOB_TIMEOUT_MS: "1500" })).toEqual({
      jobTimeoutMs: 1500,
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
  });

  it("keeps the defaults for unset, zero, negative or non-numeric values", () => {
    for (const v of [undefined, "", "0", "-5", "abc"]) {
      const opts = poolOptionsFromEnv({ CHIASMUS_GRAPH_WORKER_HEAP_MB: v, CHIASMUS_GRAPH_JOB_TIMEOUT_MS: v });
      expect(opts.jobTimeoutMs).toBeUndefined();
      expect(opts.resourceLimits).toBeUndefined();
    }
  });
});

describe("exitAfterStoppingGraphWorkers", () => {
  // The fatal-solver-error exit: process.exit() under a worker inside native
  // tree-sitter aborts the process (exit 134 and a core dump) instead of
  // exiting 1, so a busy worker must be stopped first.
  it("exits at once when no graph job is running", async () => {
    const pool = makePool();
    await run(pool, { mode: "ok" }); // worker started, now idle
    const exit = vi.fn();
    exitAfterStoppingGraphWorkers(1, { exit, pool });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("stops a busy worker cooperatively before exiting", async () => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    try {
      const pool = makePool({ cancelGraceMs: 20_000 });
      const job = run(pool, { mode: "spin-until-cancelled" });
      await new Promise((r) => setTimeout(r, 100));
      let workerGoneAtExit: boolean | undefined;
      const exit = vi.fn(() => {
        workerGoneAtExit = !pool.busy;
      });
      exitAfterStoppingGraphWorkers(1, { exit, pool });
      expect(exit).not.toHaveBeenCalled();
      expect((await job).error).toBe("graph worker pool is shut down");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 5_000 });
      expect(exit).toHaveBeenCalledTimes(1);
      expect(workerGoneAtExit).toBe(true);
      expect(terminate).not.toHaveBeenCalled();
    } finally {
      terminate.mockRestore();
    }
  });

  it("exits at the deadline when a busy worker does not stop in time", async () => {
    const pool = makePool({ cancelGraceMs: 2_000 });
    void run(pool, { mode: "hang" }); // ignores the cancel flag until terminate()
    await new Promise((r) => setTimeout(r, 100));
    // Still stopping at the exit: the deadline fired it, not close() ending
    // after the 2 s grace period.
    let busyAtExit: boolean | undefined;
    const exit = vi.fn(() => {
      busyAtExit = pool.busy;
    });
    exitAfterStoppingGraphWorkers(1, { exit, pool, deadlineMs: 200 });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 5_000 });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(busyAtExit).toBe(true);
  });
});

describe("shutdownGraphWorkers", () => {
  // Runs last in this file: the shared pool stays shut for the process.
  it("refuses later graph jobs instead of starting a new worker", async () => {
    await shutdownGraphWorkers();
    const r = await runGraphTool({ tool: "chiasmus_graph", args: { files: [], analysis: "summary" } });
    const text = (r.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text).error).toBe("graph worker pool is shut down");
  });
});
