import { describe, it, expect } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

// The daemon hung for 83 hours after a Z3 abort because nothing made the
// process exit. These run each CLI entry as its own process, crash a real
// solver module through an MCP call, and require exit code 1 so systemd's
// Restart=on-failure brings up a fresh process.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Oversized inputs overflow the Emscripten stack and trap the real module
// (see tests/solver-fatal-real.test.ts).
const Z3_TRAP = `; ${"x".repeat(24 * 1024 * 1024)}\n(declare-const x Int)`;
const PROLOG_TRAP_QUERY = `atom_length('${"a".repeat(4_000_000)}', L).`;

// Bit-blasting this factoring problem fills Z3's fixed 2 GiB heap on the
// check's pthread, so Emscripten aborts there ("Cannot enlarge memory
// arrays"): the failure mode of the incident. Takes ~12 s and 2 GiB.
const Z3_OOM_WIDTH = 16384;
const Z3_OOM = `(set-option :timeout 600000)
(declare-const a (_ BitVec ${Z3_OOM_WIDTH}))
(declare-const b (_ BitVec ${Z3_OOM_WIDTH}))
(assert (= (bvmul a b) (_ bv1000003 ${Z3_OOM_WIDTH})))
(assert (bvugt a (_ bv1 ${Z3_OOM_WIDTH})))
(assert (bvugt b (_ bv1 ${Z3_OOM_WIDTH})))`;

type Entry = {
  child: ChildProcessWithoutNullStreams;
  exit: Promise<number | null>;
  stderr: () => string;
};

function startEntry(entry: string, args: string[], home: string): Entry {
  // Only PATH and a scratch home: no LLM keys, and no real ~/.chiasmus.
  const child = spawn(process.execPath, ["--import", "tsx", join("src", entry), ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", HOME: home, CHIASMUS_HOME: home },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  // Writing to a process that has exited must not fail the test run.
  child.stdin.on("error", () => undefined);
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exit, stderr: () => stderr };
}

async function stopEntry(entry: Entry): Promise<void> {
  if (entry.child.exitCode === null && entry.child.signalCode === null) {
    entry.child.kill("SIGKILL");
  }
  await entry.exit;
}

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
      entry.exit.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    if (exited) throw new Error(`entry exited before logging "${text}":\n${entry.stderr()}`);
  }
}

/** Resolves with the JSON-RPC response to `id` on the child's stdout. */
function stdioResponse(entry: Entry, id: number): Promise<unknown> {
  return new Promise((resolve) => {
    let buffered = "";
    entry.child.stdout.setEncoding("utf8");
    entry.child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const message = JSON.parse(line) as { id?: unknown };
          if (message.id === id) resolve(message);
        } catch {
          // Not a JSON-RPC line.
        }
      }
    });
  });
}

async function expectHttpEntryToExit(
  solverArgs: Record<string, unknown>,
  solver: string,
  detail: string,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "chiasmus-entry-http-"));
  const port = await freePort();
  const entry = startEntry(
    "mcp-http-server.ts",
    ["--host", "127.0.0.1", "--port", String(port), "--path", "/mcp", "--chiasmus-home", home],
    home,
  );
  const client = new Client({ name: "entry-fatal-test", version: "0.0.1" });
  try {
    await waitForStderr(entry, "MCP Streamable HTTP server running");
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

    // A process that survives answers the call; one that exits drops it.
    const answered = client
      .callTool({ name: "chiasmus_verify", arguments: solverArgs }, undefined, { timeout: 280_000 })
      .then(() => ({ answered: true }), () => new Promise<never>(() => undefined));
    const outcome = await Promise.race([entry.exit.then((code) => ({ exit: code })), answered]);

    expect(outcome).toEqual({ exit: 1 });
    expect(entry.stderr()).toContain(`fatal ${solver} WASM error, exiting`);
    expect(entry.stderr()).toContain(detail);
  } finally {
    await client.close().catch(() => undefined);
    await stopEntry(entry);
    await rm(home, { recursive: true, force: true });
  }
}

describe("CLI entries exit when a solver module crashes", () => {
  it("chiasmus-http exits 1 on a Z3 trap", async () => {
    await expectHttpEntryToExit({ solver: "z3", input: Z3_TRAP }, "z3", "memory access out of bounds");
  }, 90_000);

  it("chiasmus (stdio) exits 1 on a Prolog trap", async () => {
    const home = await mkdtemp(join(tmpdir(), "chiasmus-entry-stdio-"));
    const entry = startEntry("mcp-server.ts", [], home);
    try {
      const answer = stdioResponse(entry, 2);
      const send = (message: object) => entry.child.stdin.write(`${JSON.stringify(message)}\n`);
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "entry-fatal-test", version: "0.0.1" },
        },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "chiasmus_verify",
          arguments: { solver: "prolog", input: "p(1).", query: PROLOG_TRAP_QUERY },
        },
      });

      const outcome = await Promise.race([
        entry.exit.then((code) => ({ exit: code })),
        answer.then(() => ({ answered: true })),
      ]);

      expect(outcome).toEqual({ exit: 1 });
      expect(entry.stderr()).toContain("fatal prolog WASM error, exiting");
      expect(entry.stderr()).toContain("memory access out of bounds");
    } finally {
      await stopEntry(entry);
      await rm(home, { recursive: true, force: true });
    }
  }, 90_000);

  it("chiasmus-http exits 1, without a native abort, when Z3 crashes during a graph job", async () => {
    // process.exit() while the graph worker is inside native tree-sitter
    // aborts the process ("terminate called after throwing an instance of
    // 'Napi::Error'", exit 134 and a core dump) instead of exiting 1, so the
    // fatal exit must stop a busy graph worker first.
    const home = await mkdtemp(join(tmpdir(), "chiasmus-entry-graph-"));
    // ~8 s of extraction uncancelled (3.9 s for half as many at load ~15),
    // so the map is still running when the trap lands well under a second in.
    const files: string[] = [];
    for (let f = 0; f < 1600; f++) {
      let src = "";
      for (let i = 0; i < 40; i++) {
        src += `export function f${f}_${i}(a: number): number { return g${i}(a) + h${f}(a, ${i}); }\n`;
      }
      const p = join(home, `m${f}.ts`);
      await writeFile(p, src);
      files.push(p);
    }
    const port = await freePort();
    const entry = startEntry(
      "mcp-http-server.ts",
      ["--host", "127.0.0.1", "--port", String(port), "--path", "/mcp", "--chiasmus-home", home],
      home,
    );
    const client = new Client({ name: "entry-fatal-test", version: "0.0.1" });
    try {
      await waitForStderr(entry, "MCP Streamable HTTP server running");
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      // Warm-up: worker started and grammar loaded, so the map below is
      // extracting by the time Z3 traps.
      await client.callTool({ name: "chiasmus_graph", arguments: { files: [files[0]], analysis: "summary" } });
      const map = client
        .callTool({ name: "chiasmus_map", arguments: { files } }, undefined, { timeout: 280_000 })
        .then((r) => (r.content as Array<{ text: string }>)[0].text, () => "request failed");
      await new Promise((r) => setTimeout(r, 300));
      void client.callTool({ name: "chiasmus_verify", arguments: { solver: "z3", input: Z3_TRAP } }).catch(() => undefined);

      const code = await entry.exit;
      const stderr = entry.stderr();
      expect(stderr).toContain("fatal z3 WASM error, exiting");
      expect(stderr).not.toMatch(/Napi::Error|terminate called/);
      expect(code).toBe(1);
      // The pool was closed (failing the running map) before the process
      // exited; an immediate process.exit() leaves the map unanswered.
      const mapOutcome = await Promise.race([map, new Promise<string>((r) => setTimeout(() => r("unanswered"), 2_000))]);
      expect(mapOutcome).toContain("graph worker pool is shut down");
    } finally {
      await client.close().catch(() => undefined);
      await stopEntry(entry);
      await rm(home, { recursive: true, force: true });
    }
  }, 120_000);

  it.runIf(process.env.CHIASMUS_Z3_ABORT_E2E)(
    "chiasmus-http exits 1 when a Z3 check aborts out of memory (CHIASMUS_Z3_ABORT_E2E=1)",
    async () => {
      await expectHttpEntryToExit(
        { solver: "z3", input: Z3_OOM },
        "z3",
        "Aborted(Cannot enlarge memory arrays",
      );
    },
    300_000,
  );
});
