import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { request, type Server as HttpServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  allowedHostnames,
  exitOnShutdownSignals,
  parseHttpOptions,
  startChiasmusHttpServer,
  type ChiasmusHttpServer,
  type HttpOptions,
} from "../src/mcp-http-server.js";
import { SkillLibrary } from "../src/skills/library.js";
import { GraphChildPool } from "../src/graph/child-pool.js";
import { SolverChildPool } from "../src/solvers/child-pool.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "http-test-client", version: "0.0.1" },
  },
};

const started: Array<{ daemon: ChiasmusHttpServer; home: string }> = [];

async function start(options: Partial<HttpOptions> = {}): Promise<{ daemon: ChiasmusHttpServer; port: number; base: string }> {
  const home = await mkdtemp(join(tmpdir(), "chiasmus-http-"));
  const daemon = await startChiasmusHttpServer({
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    sessionTtlMs: 30_000,
    chiasmusHome: home,
    ...options,
  });
  started.push({ daemon, home });
  const { port } = daemon.httpServer.address() as AddressInfo;
  return { daemon, port, base: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  for (const { daemon, home } of started.splice(0)) {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/**
 * Writes `text` on a new connection and resolves with everything the server
 * wrote back before closing it. For requests fetch and http.request won't
 * send: malformed targets, duplicate headers.
 */
function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { received += chunk; });
    socket.on("error", reject);
    socket.on("close", () => resolve(received));
    socket.write(text);
  });
}

const statusOf = (raw: string): number => Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1]);

function postInitialize(base: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(initialize),
  });
}

async function connectClient(base: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: "http-test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  await client.connect(transport);
  return { client, transport };
}

const textOf = (result: unknown): string =>
  ((result as { content: Array<{ type: string; text: string }> }).content)[0].text;

/**
 * Graph jobs answered by file name instead of a graph child: "/slow.ts" after
 * 400 ms, "/quick.ts" after 50 ms, anything else only when its MCP request is
 * cancelled (as the real pool's job ends when it kills the child).
 */
function fakeGraphJobs(): MockInstance {
  return vi.spyOn(GraphChildPool.prototype, "run").mockImplementation((job) => new Promise((resolve) => {
    const answer = (text: string) => resolve({ content: [{ type: "text", text }] });
    const file = (job.args.files as string[])[0];
    if (file === "/slow.ts") setTimeout(() => answer("slow done"), 400);
    else if (file === "/quick.ts") setTimeout(() => answer("quick done"), 50);
    else job.signal?.addEventListener("abort", () => answer("cancelled"), { once: true });
  }));
}

const graphCall = (id: string, file: string) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "chiasmus_graph", arguments: { files: [file], analysis: "summary" } },
});

const cancelOf = (id: string) => ({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });

/** POSTs raw JSON-RPC on an open session; `abort` drops the response stream. */
async function postOnSession(
  base: string,
  sessionId: string,
  body: unknown,
  protocolVersion = LATEST_PROTOCOL_VERSION,
): Promise<{ res: Response; abort: () => void }> {
  const controller = new AbortController();
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify(body),
  });
  return { res, abort: () => controller.abort() };
}

/** Reads a response stream until `text` has arrived (or the stream ends). */
async function readUntil(res: Response, text: string): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }
  return received;
}

describe("chiasmus-http options", () => {
  it("parses CLI and env options", () => {
    const options = parseHttpOptions(
      [
        "--host", "localhost",
        "--port", "4949",
        "--path", "rpc",
        "--session-ttl-ms", "1000",
        "--chiasmus-home", "/tmp/chiasmus",
        "--allowed-hosts", "chiasmus.internal, 10.0.0.5",
        "--max-body-bytes", "2048",
        "--max-sessions", "8",
      ],
      {},
    );

    expect(options).toEqual({
      host: "localhost",
      port: 4949,
      path: "/rpc",
      sessionTtlMs: 1000,
      chiasmusHome: "/tmp/chiasmus",
      allowedHosts: ["chiasmus.internal", "10.0.0.5"],
      maxBodyBytes: 2048,
      maxSessions: 8,
    });
    expect(parseHttpOptions([], {
      CHIASMUS_MCP_PORT: "5050",
      CHIASMUS_MCP_MAX_BODY_BYTES: "4096",
      CHIASMUS_MCP_MAX_SESSIONS: "2",
    })).toMatchObject({ port: 5050, maxBodyBytes: 4096, maxSessions: 2 });
  });

  it("reads allowed hosts from the environment, and leaves them unset by default", () => {
    expect(parseHttpOptions([], { CHIASMUS_MCP_ALLOWED_HOSTS: "chiasmus.internal" }).allowedHosts)
      .toEqual(["chiasmus.internal"]);
    expect(parseHttpOptions([], {}).allowedHosts).toBeUndefined();
    expect(() => parseHttpOptions(["--allowed-hosts", " , "], {})).toThrow(/allowed hosts/);
  });

  it("refuses numbers with trailing text, and values a timer or a port can't hold", () => {
    expect(() => parseHttpOptions(["--port", "3939junk"], {})).toThrow(/Invalid port/);
    expect(() => parseHttpOptions(["--port", "70000"], {})).toThrow(/Invalid port/);
    expect(() => parseHttpOptions([], { CHIASMUS_MCP_PORT: "1e3" })).toThrow(/Invalid port/);
    // setTimeout turns a longer delay into 1 ms, which would expire every session at once.
    expect(() => parseHttpOptions(["--session-ttl-ms", "2147483648"], {})).toThrow(/Invalid session TTL/);
    expect(parseHttpOptions(["--session-ttl-ms", "2147483647"], {}).sessionTtlMs).toBe(2147483647);
    expect(() => parseHttpOptions(["--max-sessions", "0"], {})).toThrow(/Invalid max sessions/);
    expect(() => parseHttpOptions(["--max-body-bytes", "-1"], {})).toThrow(/Invalid max body bytes/);
  });

  it.skipIf(process.platform === "win32")("starts when run through a symlink named chiasmus-http, as npm installs the bin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chiasmus-http-bin-"));
    try {
      const link = join(dir, "chiasmus-http");
      await symlink(join(repoRoot, "src", "mcp-http-server.ts"), link);
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", link, "--help"], {
        cwd: repoRoot,
      });
      expect(stdout).toContain("Usage: chiasmus-http");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("Chiasmus Streamable HTTP MCP server", () => {
  it("serves MCP tools over Streamable HTTP", async () => {
    const { base } = await start();
    const { client, transport } = await connectClient(base);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("chiasmus_lint");

      const result = await client.callTool({
        name: "chiasmus_lint",
        arguments: {
          solver: "z3",
          input: "(declare-const x Int)\n(assert (> x 0))\n(check-sat)",
        },
      });
      expect(JSON.parse(textOf(result)).fixes).toContain("Removed (check-sat) — added automatically by the solver");

      await transport.terminateSession();
      const health = await fetch(`${base}/healthz`);
      expect(await health.json()).toMatchObject({ ok: true, sessions: 0 });
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe("MCP HTTP sessions", () => {
  // The server closes a session after it has answered, so the client can see
  // the response before the close has run.
  async function expectClosedOnce(close: MockInstance): Promise<void> {
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce(), { timeout: 5_000 });
  }

  it("closes the session's server when the transport rejects the initialize request", async () => {
    const serverClose = vi.spyOn(Server.prototype, "close");
    const { base } = await start();

    // Without text/event-stream in Accept the transport answers 406 and
    // never initializes the session.
    const res = await postInitialize(base, { accept: "application/json" });

    expect(res.status).toBe(406);
    await expectClosedOnce(serverClose);
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ sessions: 0 });
  });

  it("closes the session's server when connecting the transport fails", async () => {
    const serverClose = vi.spyOn(Server.prototype, "close");
    vi.spyOn(Server.prototype, "connect").mockRejectedValueOnce(new Error("connect failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { base } = await start();

    const res = await postInitialize(base);

    expect(res.status).toBe(500);
    await expectClosedOnce(serverClose);
  });

  it("closes the session's server when the first request throws", async () => {
    const serverClose = vi.spyOn(Server.prototype, "close");
    vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest")
      .mockRejectedValueOnce(new Error("handle failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { base } = await start();

    const res = await postInitialize(base);

    expect(res.status).toBe(500);
    await expectClosedOnce(serverClose);
  });

  it("shares one skill library between sessions and closes it with the daemon", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const create = vi.spyOn(SkillLibrary, "create");
    const libraryClose = vi.spyOn(SkillLibrary.prototype, "close");
    const { daemon, base } = await start();
    const a = await connectClient(base);
    const b = await connectClient(base);

    try {
      // A template crafted in one session is the one the other sees.
      const crafted = await a.client.callTool({
        name: "chiasmus_craft",
        arguments: {
          name: "http-shared-template",
          domain: "validation",
          solver: "z3",
          signature: "Template crafted in one HTTP session",
          skeleton: "(declare-const x Int)\n(assert {{SLOT:condition}})",
          slots: [{ name: "condition", description: "Condition", format: "(> x 0)" }],
          normalizations: [{ source: "input", transform: "Map to SMT expression" }],
        },
      });
      expect(JSON.parse(textOf(crafted)).created).toBe(true);
      const seen = await b.client.callTool({ name: "chiasmus_skills", arguments: { name: "http-shared-template" } });
      expect(JSON.parse(textOf(seen)).template.signature).toBe("Template crafted in one HTTP session");

      await a.transport.terminateSession();
      expect(create).toHaveBeenCalledOnce();
      expect(libraryClose).not.toHaveBeenCalled();
    } finally {
      await a.client.close().catch(() => undefined);
      await b.client.close().catch(() => undefined);
    }
    await daemon.close();
    expect(libraryClose).toHaveBeenCalledOnce();
  });

  it("keeps a session whose DELETE the transport rejects", async () => {
    const { base } = await start();
    const { client, transport } = await connectClient(base);

    try {
      const res = await fetch(`${base}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": transport.sessionId!, "mcp-protocol-version": "1999-01-01" },
      });

      expect(res.status).toBe(400);
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ sessions: 1 });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("refuses a session-less POST while maxSessions sessions are open, before reading its body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { port, base } = await start({ maxSessions: 1 });
    const first = await connectClient(base);

    try {
      // Declares a body it never finishes sending: only a refusal that
      // doesn't wait for the body can answer it.
      const raw = await rawRequest(
        port,
        "POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
          + "Accept: application/json, text/event-stream\r\nContent-Length: 1000000\r\n\r\n{\"jsonrpc\"",
      );
      expect(statusOf(raw)).toBe(503);
    } finally {
      await first.client.close().catch(() => undefined);
    }
  });

  it("frees a session-less POST's slot when it turns out not to be an initialize", async () => {
    const { base } = await start({ maxSessions: 1 });

    const notInitialize = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });

    expect(notInitialize.status).toBe(400);
    expect((await postInitialize(base)).status).toBe(200);
  });

  it("doesn't expire a session while one of its tool calls runs, and expires it once idle", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fakeGraphJobs();
    const { base } = await start({ sessionTtlMs: 200 });
    const { client } = await connectClient(base);

    try {
      // Twice the idle timeout.
      const result = await client.callTool({ name: "chiasmus_graph", arguments: { files: ["/slow.ts"], analysis: "summary" } });
      expect(textOf(result)).toBe("slow done");
      expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ sessions: 1 });
      await vi.waitFor(async () => {
        expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ sessions: 0 });
      }, { timeout: 5_000 });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("doesn't expire a session while a request body is still arriving", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { port, base } = await start({ sessionTtlMs: 200 });
    const { client, transport } = await connectClient(base);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const socket = connect(port, "127.0.0.1");
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { received += chunk; });
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));

    try {
      socket.write(
        "POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
          + `Accept: application/json, text/event-stream\r\nMcp-Session-Id: ${transport.sessionId}\r\n`
          + `Mcp-Protocol-Version: ${LATEST_PROTOCOL_VERSION}\r\n`
          + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body.slice(0, 10)}`,
      );
      // Three idle timeouts pass while the upload is under way.
      await new Promise((r) => setTimeout(r, 600));
      expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ sessions: 1 });

      socket.write(body.slice(10));
      await closed;
      expect(statusOf(received)).toBe(200);
    } finally {
      socket.destroy();
      await client.close().catch(() => undefined);
    }
  });

  it("lets a session expire once its tool call is cancelled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = fakeGraphJobs();
    const { base } = await start({ sessionTtlMs: 300 });
    const { client } = await connectClient(base);

    try {
      const cancel = new AbortController();
      const call = client.callTool(
        { name: "chiasmus_graph", arguments: { files: ["/until-cancelled.ts"], analysis: "summary" } },
        undefined,
        { signal: cancel.signal },
      );
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      cancel.abort();
      await expect(call).rejects.toThrow();

      // The SDK sends no response to a cancelled request, so its POST stays
      // open; the session still goes idle.
      await vi.waitFor(async () => {
        expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ sessions: 0 });
      }, { timeout: 5_000 });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("lets a session expire when one POST carries a request and its cancellation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fakeGraphJobs();
    const { base } = await start({ sessionTtlMs: 300 });
    const { client, transport } = await connectClient(base);
    const post = await postOnSession(base, transport.sessionId!, [graphCall("A", "/until-cancelled.ts"), cancelOf("A")]);

    try {
      await vi.waitFor(async () => {
        expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ sessions: 0 });
      }, { timeout: 5_000 });
    } finally {
      post.abort();
      await client.close().catch(() => undefined);
    }
  });

  it("still answers a request whose POST it shares with a cancelled one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = fakeGraphJobs();
    const { base } = await start();
    const { client, transport } = await connectClient(base);
    const batch = await postOnSession(base, transport.sessionId!, [graphCall("A", "/until-cancelled.ts"), graphCall("B", "/slow.ts")]);

    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      const cancel = await postOnSession(base, transport.sessionId!, cancelOf("A"));
      expect(cancel.res.status).toBe(202);

      expect(await readUntil(batch.res, "slow done")).toContain("slow done");
    } finally {
      batch.abort();
      await client.close().catch(() => undefined);
    }
  });

  it("keeps a session busy when the SDK rejects a malformed cancellation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = fakeGraphJobs();
    const { base } = await start({ sessionTtlMs: 300 });
    const { client, transport } = await connectClient(base);
    const call = await postOnSession(base, transport.sessionId!, graphCall("A", "/until-cancelled.ts"));

    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      // A reason that isn't a string: the SDK refuses the notification and
      // the request keeps running.
      const malformed = { ...cancelOf("A"), params: { requestId: "A", reason: 123 } };
      await postOnSession(base, transport.sessionId!, malformed);
      await new Promise((r) => setTimeout(r, 900));

      expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ sessions: 1 });
    } finally {
      call.abort();
      await client.close().catch(() => undefined);
    }
  });

  it("keeps running and answers a request whose cancellation the transport rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = fakeGraphJobs();
    const { base } = await start();
    const { client, transport } = await connectClient(base);
    const call = await postOnSession(base, transport.sessionId!, graphCall("A", "/slow.ts"));

    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      const rejected = await postOnSession(base, transport.sessionId!, cancelOf("A"), "1999-01-01");
      expect(rejected.res.status).toBe(400);

      expect(await readUntil(call.res, "slow done")).toContain("slow done");
    } finally {
      call.abort();
      await client.close().catch(() => undefined);
    }
  });

  it("refuses an initialize while maxSessions sessions are open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { base } = await start({ maxSessions: 1 });
    const first = await connectClient(base);

    try {
      const refused = await postInitialize(base);
      expect(refused.status).toBe(503);
      expect((await refused.json()).error.message).toBe("Too many MCP sessions (1)");

      await first.transport.terminateSession();
      expect((await postInitialize(base)).status).toBe(200);
    } finally {
      await first.client.close().catch(() => undefined);
    }
  });
});

describe("MCP HTTP request handling", () => {
  it("answers 400 to a request target it can't parse or that names an absolute URL, and keeps serving", async () => {
    const { port } = await start();
    const get = (target: string) => rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);

    expect(statusOf(await get("http://["))).toBe(400);
    expect(statusOf(await get("//["))).toBe(400);
    expect(statusOf(await get("http://localhost:99999/mcp"))).toBe(400);
    expect(statusOf(await get("http://rebind.example/healthz"))).toBe(400);
    // URL would read these as another host's /healthz and as /healthz.
    expect(statusOf(await get("/\\rebind.example/healthz"))).toBe(400);
    expect(statusOf(await get("/healthz#fragment"))).toBe(400);
    expect(statusOf(await get("/healthz"))).toBe(200);
  });

  it("answers 413 to a body over maxBodyBytes, declared or streamed, and keeps serving", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { port, base } = await start({ maxBodyBytes: 1024 });
    const body = JSON.stringify({ ...initialize, params: { ...initialize.params, padding: "x".repeat(2048) } });
    const head = "POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n"
      + "Accept: application/json, text/event-stream\r\nConnection: close\r\n";
    const chunked = (s: string) => `${Buffer.byteLength(s).toString(16)}\r\n${s}\r\n0\r\n\r\n`;

    expect(statusOf(await rawRequest(port, `${head}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`))).toBe(413);
    expect(statusOf(await rawRequest(port, `${head}Transfer-Encoding: chunked\r\n\r\n${chunked(body)}`))).toBe(413);
    expect((await postInitialize(base)).status).toBe(200);
  });

  it("answers 404 to a request for a session it doesn't have", async () => {
    const { base } = await start();

    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "no-such-session" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });

    expect(res.status).toBe(404);
  });

  it("names the methods it supports in a 405", async () => {
    const { base } = await start();

    const res = await fetch(`${base}/mcp`, { method: "PUT" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST, DELETE");
  });
});

describe("MCP HTTP Host and Origin checks", () => {
  /**
   * Sends one request to the server with exactly these headers. fetch picks
   * the Host header itself, so a rebound page's request can't be built with it.
   */
  function send(port: number, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path,
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? headers : {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        agent: false,
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  const body = JSON.stringify(initialize);

  it("refuses an initialize sent under another site's hostname, before it starts a session", async () => {
    // A DNS-rebound page reaches 127.0.0.1, but its browser names the page's
    // own site in Host.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { port } = await start();
    const serverConnect = vi.spyOn(Server.prototype, "connect");

    const res = await send(port, "/mcp", { host: `rebind.example:${port}` }, body);

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.message).toBe(`Invalid Host header: rebind.example:${port}`);
    expect(serverConnect).not.toHaveBeenCalled();
    expect((await send(port, "/healthz", { host: `rebind.example:${port}` })).status).toBe(403);
    expect(JSON.parse((await send(port, "/healthz", { host: `127.0.0.1:${port}` })).body)).toMatchObject({ sessions: 0 });
  });

  it("refuses a Host that only names a loopback address after credentials", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { port } = await start();

    expect((await send(port, "/healthz", { host: `rebind.example@127.0.0.1:${port}` })).status).toBe(403);
  });

  it("refuses a request with two Host headers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { port } = await start();

    const raw = await rawRequest(
      port,
      `GET /healthz HTTP/1.1\r\nHost: localhost:${port}\r\nHost: rebind.example:${port}\r\nConnection: close\r\n\r\n`,
    );

    expect(statusOf(raw)).toBe(403);
  });

  it("refuses a request from a page on another site, or with an Origin that isn't one, before it starts a session", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { port } = await start();
    const serverConnect = vi.spyOn(Server.prototype, "connect");
    const host = `127.0.0.1:${port}`;

    for (const origin of ["http://rebind.example", "null", "http://rebind.example@localhost", "http://localhost/rebind"]) {
      const res = await send(port, "/mcp", { host, origin }, body);
      expect(res.status, origin).toBe(403);
      expect(JSON.parse(res.body).error.message, origin).toBe(`Invalid Origin header: ${origin}`);
    }
    expect(serverConnect).not.toHaveBeenCalled();
  });

  it("serves the loopback hostnames, and a page served from one", async () => {
    const { port } = await start();

    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
      expect((await send(port, "/healthz", { host })).status, host).toBe(200);
    }
    const res = await send(port, "/mcp", { host: `localhost:${port}`, origin: "http://localhost:6274" }, body);
    expect(res.status).toBe(200);
  });

  it("serves a hostname given in allowedHosts as well as the loopback ones", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { port } = await start({ allowedHosts: ["chiasmus.internal"] });

    expect((await send(port, "/healthz", { host: `chiasmus.internal:${port}` })).status).toBe(200);
    expect((await send(port, "/healthz", { host: `localhost:${port}` })).status).toBe(200);
    expect((await send(port, "/healthz", { host: `rebind.example:${port}` })).status).toBe(403);
  });

  it("allows the bound host's name unless it is a wildcard address", () => {
    const loopback = ["localhost", "127.0.0.1", "[::1]"];
    expect([...allowedHostnames({ host: "127.0.0.1" })].sort()).toEqual([...loopback].sort());
    expect([...allowedHostnames({ host: "::1" })].sort()).toEqual([...loopback].sort());
    expect([...allowedHostnames({ host: "0.0.0.0" })].sort()).toEqual([...loopback].sort());
    expect([...allowedHostnames({ host: "::" })].sort()).toEqual([...loopback].sort());
    expect(allowedHostnames({ host: "192.168.1.5" })).toContain("192.168.1.5");
    expect(allowedHostnames({ host: "127.0.0.1", allowedHosts: ["Chiasmus.Internal", "fe80::1"] }))
      .toEqual(new Set([...loopback, "chiasmus.internal", "[fe80::1]"]));
    expect(() => allowedHostnames({ host: "127.0.0.1", allowedHosts: ["chiasmus.internal:3939"] }))
      .toThrow(/Invalid allowed host/);
  });
});

describe("MCP HTTP server shutdown", () => {
  it("close() closes the sessions, the shared library and the listener, and can run twice", async () => {
    const serverClose = vi.spyOn(Server.prototype, "close");
    const libraryClose = vi.spyOn(SkillLibrary.prototype, "close");
    const { daemon, base } = await start();
    const { client } = await connectClient(base);

    try {
      await daemon.close();
      await daemon.close();

      expect(serverClose).toHaveBeenCalledOnce();
      expect(libraryClose).toHaveBeenCalledOnce();
      expect(daemon.httpServer.listening).toBe(false);
      await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("does not register a session whose initialize finishes after close() began, and waits for its request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const serverClose = vi.spyOn(Server.prototype, "close");
    const libraryClose = vi.spyOn(SkillLibrary.prototype, "close");
    let connected: (() => void) | undefined;
    const connect = Server.prototype.connect;
    vi.spyOn(Server.prototype, "connect").mockImplementation(async function (this: Server, transport) {
      // Hold the initialize between the shutdown check and registration.
      await new Promise<void>((resolve) => { connected = resolve; });
      return connect.call(this, transport);
    });
    const { daemon, base } = await start();

    const pending = postInitialize(base).catch(() => undefined);
    await vi.waitFor(() => expect(connected).toBeDefined());
    const closed = daemon.close();
    let closedYet = false;
    void closed.then(() => { closedYet = true; });
    // Long enough for close() to finish everything but the held request.
    await new Promise((r) => setTimeout(r, 200));
    expect(closedYet).toBe(false);
    connected!();
    await closed;

    // close() waited for the starting session's request, which closed its
    // server, before closing the library that session was given.
    expect(serverClose).toHaveBeenCalledOnce();
    expect(libraryClose).toHaveBeenCalledOnce();
    expect(serverClose.mock.invocationCallOrder[0]).toBeLessThan(libraryClose.mock.invocationCallOrder[0]);
    await pending;
  });

  type Shutdown = {
    url: URL;
    /** Runs the SIGTERM handler exitOnShutdownSignals installed. */
    sigterm: () => void;
    /** Lets the graph pool's close() resolve. */
    release: () => void;
    poolClose: MockInstance;
    exit: MockInstance;
  };

  /**
   * Runs `body` against a daemon whose signal shutdown can be watched part
   * way: process.exit is stubbed, and the graph pool's close() stays pending
   * until `release()`, as it does while a killed graph child is being reaped.
   */
  async function withShutdown(body: (s: Shutdown) => Promise<void>): Promise<void> {
    let release: (() => void) | undefined;
    const poolClose = vi.spyOn(GraphChildPool.prototype, "close")
      .mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const earlier = { SIGTERM: new Set(process.listeners("SIGTERM")), SIGINT: new Set(process.listeners("SIGINT")) };
    let signalled = false;
    try {
      const { daemon, base } = await start();
      exitOnShutdownSignals(daemon);
      const onSigterm = process.listeners("SIGTERM").find((l) => !earlier.SIGTERM.has(l));
      expect(onSigterm).toBeDefined();
      await body({
        url: new URL(`${base}/mcp`),
        sigterm: () => {
          signalled = true;
          onSigterm!("SIGTERM");
        },
        release: () => release!(),
        poolClose,
        exit,
      });
    } finally {
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        for (const l of process.listeners(signal)) if (!earlier[signal].has(l)) process.removeListener(signal, l);
      }
      release?.();
      // A shutdown that a failed test left under way must end in the stub,
      // not in the real process.exit.
      if (signalled) await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 5_000 }).catch(() => undefined);
    }
  }

  it("exits with the signal's code when the shutdown is still draining at its deadline", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const earlier = { SIGTERM: new Set(process.listeners("SIGTERM")), SIGINT: new Set(process.listeners("SIGINT")) };
    const stuck: ChiasmusHttpServer = {
      httpServer: undefined as unknown as HttpServer,
      close: () => new Promise<void>(() => undefined),
    };
    try {
      exitOnShutdownSignals(stuck, 50);
      process.listeners("SIGTERM").find((l) => !earlier.SIGTERM.has(l))!("SIGTERM");

      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    } finally {
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        for (const l of process.listeners(signal)) if (!earlier[signal].has(l)) process.removeListener(signal, l);
      }
    }
  });

  it("kills the graph child process before exiting on SIGTERM", async () => {
    await withShutdown(async ({ sigterm, release, poolClose, exit }) => {
      sigterm();

      await vi.waitFor(() => expect(poolClose).toHaveBeenCalledOnce());
      expect(exit).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    });
  });

  it("kills the solver child processes before exiting on SIGTERM", async () => {
    let releaseSolvers!: () => void;
    const held = new Promise<void>((resolve) => { releaseSolvers = resolve; });
    const solverClose = vi.spyOn(SolverChildPool.prototype, "close").mockImplementation(() => held);
    try {
      await withShutdown(async ({ sigterm, release, poolClose, exit }) => {
        sigterm();
        await vi.waitFor(() => expect(poolClose).toHaveBeenCalledOnce());
        release();

        // One pool per solver.
        await vi.waitFor(() => expect(solverClose).toHaveBeenCalledTimes(2));
        await new Promise((r) => setTimeout(r, 50));
        expect(exit).not.toHaveBeenCalled();
        releaseSolvers();
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
      });
    } finally {
      releaseSolvers();
      solverClose.mockRestore();
    }
  });

  it("refuses a client that connects while it shuts down, and still exits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withShutdown(async ({ url, sigterm, release, poolClose, exit }) => {
      const open = new Client({ name: "http-test-client", version: "0.0.1" });
      const late = new Client({ name: "http-test-client", version: "0.0.1" });
      try {
        await open.connect(new StreamableHTTPClientTransport(url));
        sigterm();
        await vi.waitFor(() => expect(poolClose).toHaveBeenCalledOnce());

        // The graph child is still being reaped; the daemon takes no new session.
        await expect(late.connect(new StreamableHTTPClientTransport(url))).rejects.toThrow();
        release();
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143), { timeout: 5_000 });
      } finally {
        await late.close().catch(() => undefined);
        await open.close().catch(() => undefined);
      }
    });
  });
});
