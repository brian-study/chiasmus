import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { MAX_FILE_SIZE } from "../src/graph/analyses.js";

// A solver WASM abort used to leave the server process running with a broken
// solver module, or hung in it. These run each CLI entry as its own process,
// crash a real solver module through an MCP call, and require exit code 1
// before any answer arrives.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// An oversized query overflows the Emscripten stack and traps the real module
// (see tests/solver-fatal-real.test.ts). The input that traps Z3 that way is
// 24 MiB, over the stdio transport's 10 MiB message limit, so the Z3 trap is
// only covered in process there.
const PROLOG_TRAP_QUERY = `atom_length('${"a".repeat(4_000_000)}', L).`;

// chiasmus-http reads request bodies itself, with no such limit, so the Z3
// trap runs through it.
const Z3_TRAP = `; ${"x".repeat(24 * 1024 * 1024)}\n(declare-const x Int)`;

// Bit-blasting this factoring problem fills Z3's fixed 2 GiB heap on the
// check's pthread, so Emscripten aborts there ("Cannot enlarge memory
// arrays"): what a solve that runs out of heap does. Takes ~12 s and 2 GiB.
const Z3_OOM_WIDTH = 16384;
const Z3_OOM = `(set-option :timeout 600000)
(declare-const a (_ BitVec ${Z3_OOM_WIDTH}))
(declare-const b (_ BitVec ${Z3_OOM_WIDTH}))
(assert (= (bvmul a b) (_ bv1000003 ${Z3_OOM_WIDTH})))
(assert (bvugt a (_ bv1 ${Z3_OOM_WIDTH})))
(assert (bvugt b (_ bv1 ${Z3_OOM_WIDTH})))`;

// What a C++ exception escaping native code during teardown prints before
// SIGABRT (node-addon-api's Napi::Error).
const NATIVE_ABORT = /Napi::Error|terminate called/;

type Entry = {
  child: ChildProcessWithoutNullStreams;
  /**
   * Exit code, once the process has exited and every holder of its stdio
   * pipes has closed them. Its graph child process writes to the same stderr,
   * so this also waits for that child.
   */
  exit: Promise<number | null>;
  /** The process itself has exited; its graph child may still be running. */
  gone: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: () => string;
  /** The JSON-RPC response to `id` on the child's stdout (stdio entry). */
  response: (id: number) => Promise<unknown>;
};

/**
 * Entry processes not yet exited. A test that times out never reaches its
 * own cleanup, and an HTTP entry has nothing else that would ever stop it, so
 * these are killed after each test, and when this test process exits.
 * (vitest stops a worker with SIGTERM, which runs no 'exit' listeners, so the
 * afterEach is what catches a test that timed out.)
 */
const running = new Set<ChildProcess>();
const killRunning = (): void => {
  for (const child of running) child.kill("SIGKILL");
};
process.on("exit", killRunning);
afterAll(() => {
  process.off("exit", killRunning);
});
afterEach(killRunning);

function startEntry(home: string, entry = "mcp-server.ts", args: string[] = []): Entry {
  // Only PATH and a scratch home: no LLM keys, and no real ~/.chiasmus.
  const child = spawn(process.execPath, ["--import", "tsx", join("src", entry), ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", HOME: home, CHIASMUS_HOME: home },
  });
  running.add(child);
  child.once("exit", () => running.delete(child));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const responses = new Map<number, unknown>();
  const waiting = new Map<number, (message: unknown) => void>();
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      let message: { id?: unknown };
      try {
        message = JSON.parse(line) as { id?: unknown };
      } catch {
        continue; // Not a JSON-RPC line.
      }
      if (typeof message.id !== "number") continue;
      responses.set(message.id, message);
      waiting.get(message.id)?.(message);
    }
  });
  // Writing to a process that has exited must not fail the test run.
  child.stdin.on("error", () => undefined);
  // "close", not "exit": stderr can still hold the fatal log line when "exit" fires.
  const exit = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  const gone = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exit,
    gone,
    stderr: () => stderr,
    response: (id) => (responses.has(id)
      ? Promise.resolve(responses.get(id))
      : new Promise((resolve) => waiting.set(id, resolve))),
  };
}

async function stopEntry(entry: Entry): Promise<void> {
  if (entry.child.exitCode === null && entry.child.signalCode === null) {
    entry.child.kill("SIGKILL");
  }
  await entry.exit;
}

/** An initialized MCP client on the stdio entry; `call` never settles if the process exits first. */
function stdioCaller(entry: Entry): { call: (name: string, args: Record<string, unknown>) => Promise<unknown> } {
  let nextId = 1;
  const send = (message: object) => entry.child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params: object) => {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method, params });
    return entry.response(id);
  };
  void request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "entry-fatal-test", version: "0.0.1" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { call: (name, args) => request("tools/call", { name, arguments: args }) };
}

async function expectEntryToExit(
  verifyArgs: Record<string, unknown>,
  solver: string,
  detail: string,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "chiasmus-entry-stdio-"));
  const entry = startEntry(home);
  try {
    // A process that survives answers the call; one that exits drops it.
    const answer = stdioCaller(entry).call("chiasmus_verify", verifyArgs);

    const outcome = await Promise.race([
      entry.exit.then((code) => ({ exit: code })),
      answer.then(() => ({ answered: true })),
    ]);

    expect(outcome).toEqual({ exit: 1 });
    expect(entry.stderr()).toContain(`fatal ${solver} WASM error, exiting`);
    expect(entry.stderr()).toContain(detail);
  } finally {
    await stopEntry(entry);
    await rm(home, { recursive: true, force: true });
  }
}

describe("CLI entry exits when a solver module crashes", () => {
  it("exits 1 on a Prolog trap", async () => {
    await expectEntryToExit(
      { solver: "prolog", input: "p(1).", query: PROLOG_TRAP_QUERY },
      "prolog",
      "memory access out of bounds",
    );
  }, 90_000);

  it.runIf(process.env.CHIASMUS_Z3_ABORT_E2E)(
    "exits 1 when a Z3 check aborts out of memory (CHIASMUS_Z3_ABORT_E2E=1)",
    async () => {
      await expectEntryToExit(
        { solver: "z3", input: Z3_OOM },
        "z3",
        "Aborted(Cannot enlarge memory arrays",
      );
    },
    300_000,
  );
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitForStderr(entry: Entry, text: string): Promise<void> {
  while (!entry.stderr().includes(text)) {
    const exited = await Promise.race([
      entry.gone.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    if (exited) throw new Error(`entry exited before logging "${text}":\n${entry.stderr()}`);
  }
}

type HttpEntry = Entry & {
  url: URL;
  /** A connected MCP client; `call` rejects if the process exits first. */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
};

async function startHttpEntry(home: string): Promise<HttpEntry> {
  const port = await freePort();
  const entry = startEntry(
    home,
    "mcp-http-server.ts",
    ["--host", "127.0.0.1", "--port", String(port), "--path", "/mcp", "--chiasmus-home", home],
  );
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const client = new Client({ name: "entry-fatal-test", version: "0.0.1" });
  try {
    await waitForStderr(entry, "MCP Streamable HTTP server running");
    await client.connect(new StreamableHTTPClientTransport(url));
  } catch (e) {
    await stopEntry(entry);
    throw e;
  }
  return {
    ...entry,
    url,
    call: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 280_000 }),
    close: () => client.close().catch(() => undefined),
  };
}

async function expectHttpEntryToExit(
  verifyArgs: Record<string, unknown>,
  solver: string,
  detail: string,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "chiasmus-entry-http-"));
  const entry = await startHttpEntry(home);
  try {
    // A process that survives answers the call; one that exits drops it.
    const answered = entry
      .call("chiasmus_verify", verifyArgs)
      .then(() => ({ answered: true }), () => new Promise<never>(() => undefined));
    const outcome = await Promise.race([entry.exit.then((code) => ({ exit: code })), answered]);

    expect(outcome).toEqual({ exit: 1 });
    expect(entry.stderr()).toContain(`fatal ${solver} WASM error, exiting`);
    expect(entry.stderr()).toContain(detail);
  } finally {
    await entry.close();
    await stopEntry(entry);
    await rm(home, { recursive: true, force: true });
  }
}

describe("chiasmus-http exits when a solver module crashes", () => {
  it("exits 1 on a Z3 trap", async () => {
    await expectHttpEntryToExit({ solver: "z3", input: Z3_TRAP }, "z3", "memory access out of bounds");
  }, 90_000);

  it.runIf(process.env.CHIASMUS_Z3_ABORT_E2E)(
    "exits 1 when a Z3 check aborts out of memory (CHIASMUS_Z3_ABORT_E2E=1)",
    async () => {
      await expectHttpEntryToExit({ solver: "z3", input: Z3_OOM }, "z3", "Aborted(Cannot enlarge memory arrays");
    },
    300_000,
  );
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await sleep(50);
  return !alive(pid);
}

/** Polls `probe` until it returns a value; throws after `ms`. */
async function until<T>(probe: () => T | undefined, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** One `ps` column of `pid`, or "" when there is no such process. */
function ps(pid: number, column: "stat" | "args"): string {
  try {
    return execFileSync("ps", ["-o", `${column}=`, "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Graph child processes of `pid` (`ps -A -o pid=,ppid=` works on Linux and macOS). */
function graphChildrenOf(pid: number): number[] {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", maxBuffer: 64 * 1024 ** 2 });
  return out.split("\n").flatMap((line) => {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    return pp === pid && ps(p, "args").includes("graph-child") ? [p] : [];
  });
}

/** Running or runnable (ps state R): working on a job, not waiting on IPC. */
const busy = (pid: number) => ps(pid, "stat").startsWith("R");

/**
 * SIGSTOPs the graph children in the middle of their job, before the server
 * is stopped. A stopped child can neither finish its job nor notice that the
 * server is gone: its IPC 'disconnect' handler and its parent watchdog (which
 * polls every 500 ms) never run. So once the server has exited, only a
 * SIGKILL sent by the server can have ended it, and the no-survivor check
 * fails every time the server leaves a child behind, not only when it
 * happens to look before the watchdog does. It stands in for a child busy in
 * a long tree walk, which doesn't see the IPC channel close either.
 */
function hold(pids: number[]): void {
  for (const pid of pids) process.kill(pid, "SIGSTOP");
}

// The fatal exit is process.exit(1). Under the graph tools' former worker
// thread, that exit while the thread was inside native tree-sitter made
// node-addon-api's Napi::Error escape and the process abort (SIGABRT, exit
// 134 and a core dump). In a child process the graph work can't take the
// server down, but the child must not run on after the server is gone.
// POSIX only: the checks use ps and signals.
describe.skipIf(process.platform === "win32")("a solver crash or SIGTERM during a graph job", () => {
  // One TypeScript file of 90,000 small functions (6.5 MB, under
  // MAX_FILE_SIZE): parsing takes about a second and the tree walk many
  // more, all inside native tree-sitter in the graph child.
  let root: string;
  let smallFile: string;
  let bigFile: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-entry-graph-"));
    smallFile = join(root, "warm.ts");
    bigFile = join(root, "large.ts");
    await writeFile(smallFile, "export function warm() { return 1; }\n");
    let src = "";
    for (let i = 0; i < 90_000; i++) {
      src += `export function f${i}(a: number): number { return g(a) + h(a, ${i}); }\n`;
    }
    expect(Buffer.byteLength(src)).toBeLessThan(MAX_FILE_SIZE);
    await writeFile(bigFile, src);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  type Caller = { call: (name: string, args: Record<string, unknown>) => Promise<unknown> };

  /**
   * Starts a chiasmus_map over the big file, holds the graph child once it is
   * walking it (see hold()), calls `stop` (a solver crash or a signal), and
   * waits for the entry process to exit. Graph children still alive then are
   * killed, so the entry's stdio can close.
   */
  async function stopDuringGraphJob(entry: Entry, caller: Caller, stop: () => void) {
    // Warm-up: graph child started and the TypeScript grammar loaded, so the
    // map below goes straight to parsing.
    await caller.call("chiasmus_graph", { files: [smallFile], analysis: "summary" });
    let mapAnswered = false;
    void caller.call("chiasmus_map", { files: [bigFile] }).then(() => { mapAnswered = true; }, () => undefined);
    const graphPids = await until(() => {
      const kids = graphChildrenOf(entry.child.pid!);
      return kids.some(busy) ? kids : undefined;
    }, 30_000, "the graph child to start the map");
    const survivors: number[] = [];
    let exited: Awaited<Entry["gone"]> | "still running";
    let exitMs: number | undefined;
    try {
      await sleep(1_000); // past parsing, into the walk
      hold(graphPids);
      const stoppedAt = Date.now();
      stop();
      exited = await Promise.race([entry.gone, sleep(30_000).then(() => "still running" as const)]);
      if (exited !== "still running") {
        exitMs = Date.now() - stoppedAt;
        for (const pid of graphPids) if (!(await waitGone(pid, 3_000))) survivors.push(pid);
      }
    } finally {
      for (const pid of graphPids) if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    await stopEntry(entry);
    return { exited, exitMs, mapAnswered, graphPids, survivors };
  }

  it("the stdio entry exits 1 on a Prolog trap and leaves no graph process", async () => {
    const home = await mkdtemp(join(tmpdir(), "chiasmus-entry-stdio-graph-"));
    const entry = startEntry(home);
    try {
      const caller = stdioCaller(entry);
      const run = await stopDuringGraphJob(entry, caller, () => {
        void caller.call("chiasmus_verify", { solver: "prolog", input: "p(1).", query: PROLOG_TRAP_QUERY });
      });

      const stderr = entry.stderr();
      expect(stderr).toContain("fatal prolog WASM error, exiting");
      expect(stderr).not.toMatch(NATIVE_ABORT);
      expect(run.exited).toEqual({ code: 1, signal: null });
      // Still walking when the server exited: the map got no answer.
      expect(run.mapAnswered).toBe(false);
      expect(run.graphPids.length).toBeGreaterThan(0);
      expect(run.survivors).toEqual([]);
    } finally {
      await stopEntry(entry);
      await rm(home, { recursive: true, force: true });
    }
  }, 120_000);

  it("the HTTP entry exits 1 on a Z3 trap and leaves no graph process", async () => {
    const home = await mkdtemp(join(tmpdir(), "chiasmus-entry-http-graph-"));
    const entry = await startHttpEntry(home);
    try {
      const run = await stopDuringGraphJob(entry, entry, () => {
        void entry.call("chiasmus_verify", { solver: "z3", input: Z3_TRAP }).catch(() => undefined);
      });

      const stderr = entry.stderr();
      expect(stderr).toContain("fatal z3 WASM error, exiting");
      expect(stderr).not.toMatch(NATIVE_ABORT);
      expect(run.exited).toEqual({ code: 1, signal: null });
      expect(run.mapAnswered).toBe(false);
      expect(run.graphPids.length).toBeGreaterThan(0);
      expect(run.survivors).toEqual([]);
    } finally {
      await entry.close();
      await stopEntry(entry);
      await rm(home, { recursive: true, force: true });
    }
  }, 120_000);

  it("the HTTP entry exits 143 on SIGTERM, with clients connecting meanwhile, and leaves no graph process", async () => {
    const home = await mkdtemp(join(tmpdir(), "chiasmus-entry-http-sigterm-"));
    const entry = await startHttpEntry(home);
    // Clients that connect while the daemon shuts down. One that got a
    // session then would keep the daemon up through its GET stream.
    const late = Array.from({ length: 5 }, () => new Client({ name: "entry-fatal-test", version: "0.0.1" }));
    try {
      const run = await stopDuringGraphJob(entry, entry, () => {
        entry.child.kill("SIGTERM");
        late.forEach((client, i) => {
          setTimeout(() => {
            client.connect(new StreamableHTTPClientTransport(entry.url)).catch(() => undefined);
          }, i * 10);
        });
      });

      expect(entry.stderr()).not.toMatch(NATIVE_ABORT);
      expect(run.exited).toEqual({ code: 143, signal: null });
      expect(run.exitMs).toBeLessThan(5_000);
      expect(run.graphPids.length).toBeGreaterThan(0);
      expect(run.survivors).toEqual([]);
    } finally {
      await Promise.all(late.map((client) => client.close().catch(() => undefined)));
      await entry.close();
      await stopEntry(entry);
      await rm(home, { recursive: true, force: true });
    }
  }, 120_000);
});
