import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { request, type Server as HttpServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedHostnames, parseHttpOptions, startChiasmusHttpServer } from "../src/mcp-http-server.js";
import { SkillLibrary } from "../src/skills/library.js";
import { GraphChildPool } from "../src/graph/child-pool.js";

describe("Chiasmus Streamable HTTP MCP server", () => {
  it("parses CLI and env options", () => {
    const options = parseHttpOptions(
      [
        "--host", "localhost",
        "--port", "4949",
        "--path", "rpc",
        "--session-ttl-ms", "1000",
        "--chiasmus-home", "/tmp/chiasmus",
        "--allowed-hosts", "chiasmus.internal, 10.0.0.5",
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
    });
  });

  it("reads allowed hosts from the environment, and leaves them unset by default", () => {
    expect(parseHttpOptions([], { CHIASMUS_MCP_ALLOWED_HOSTS: "chiasmus.internal" }).allowedHosts)
      .toEqual(["chiasmus.internal"]);
    expect(parseHttpOptions([], {}).allowedHosts).toBeUndefined();
    expect(() => parseHttpOptions(["--allowed-hosts", " , "], {})).toThrow(/allowed hosts/);
  });

  it("serves MCP tools over Streamable HTTP", async () => {
    const chiasmusHome = await mkdtemp(join(tmpdir(), "chiasmus-http-mcp-"));
    const httpServer = await startChiasmusHttpServer({
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      sessionTtlMs: 30_000,
      chiasmusHome,
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP listener address");
    }

    const client = new Client({ name: "http-test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("chiasmus_lint");

      const result = await client.callTool({
        name: "chiasmus_lint",
        arguments: {
          solver: "z3",
          input: "(declare-const x Int)\n(assert (> x 0))\n(check-sat)",
        },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(JSON.parse(text).fixes).toContain("Removed (check-sat) — added automatically by the solver");

      await transport.terminateSession();
      const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      expect(await health.json()).toMatchObject({ ok: true, sessions: 0 });
    } finally {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await rm(chiasmusHome, { recursive: true, force: true });
    }
  });
});

describe("MCP HTTP session start failures", () => {
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

  let httpServer: HttpServer | undefined;
  let chiasmusHome: string | undefined;

  async function start(): Promise<string> {
    chiasmusHome = await mkdtemp(join(tmpdir(), "chiasmus-http-mcp-"));
    httpServer = await startChiasmusHttpServer({
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      sessionTtlMs: 30_000,
      chiasmusHome,
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP listener address");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  // The server closes a session after it has answered, so the client can see
  // the response before the close has run.
  async function expectClosedOnce(...closes: Array<ReturnType<typeof vi.spyOn>>): Promise<void> {
    await vi.waitFor(() => {
      for (const close of closes) expect(close).toHaveBeenCalledOnce();
    }, { timeout: 5_000 });
  }

  async function postInitialize(base: string, accept: string): Promise<Response> {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept },
      body: JSON.stringify(initialize),
    });
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    const server = httpServer;
    httpServer = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (chiasmusHome) await rm(chiasmusHome, { recursive: true, force: true });
    chiasmusHome = undefined;
  });

  it("closes the server and library when the transport rejects the initialize request", async () => {
    const libraryClose = vi.spyOn(SkillLibrary.prototype, "close");
    const serverClose = vi.spyOn(Server.prototype, "close");
    const base = await start();

    // Without text/event-stream in Accept the transport answers 406 and
    // never initializes the session.
    const res = await postInitialize(base, "application/json");

    expect(res.status).toBe(406);
    await expectClosedOnce(serverClose, libraryClose);
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ sessions: 0 });
  });

  it("closes the server and library when connecting the transport fails", async () => {
    const libraryClose = vi.spyOn(SkillLibrary.prototype, "close");
    const serverClose = vi.spyOn(Server.prototype, "close");
    vi.spyOn(Server.prototype, "connect").mockRejectedValueOnce(new Error("connect failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const base = await start();

    const res = await postInitialize(base, "application/json, text/event-stream");

    expect(res.status).toBe(500);
    await expectClosedOnce(serverClose, libraryClose);
  });

  it("closes the server and library when the first request throws", async () => {
    const libraryClose = vi.spyOn(SkillLibrary.prototype, "close");
    const serverClose = vi.spyOn(Server.prototype, "close");
    vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest")
      .mockRejectedValueOnce(new Error("handle failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const base = await start();

    const res = await postInitialize(base, "application/json, text/event-stream");

    expect(res.status).toBe(500);
    await expectClosedOnce(serverClose, libraryClose);
  });

  it("keeps the library open for a session that did initialize", async () => {
    const libraryClose = vi.spyOn(SkillLibrary.prototype, "close");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const base = await start();
    const client = new Client({ name: "http-test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));

    try {
      await client.connect(transport);
      await client.listTools();
      expect(libraryClose).not.toHaveBeenCalled();

      await transport.terminateSession();
      await vi.waitFor(() => expect(libraryClose).toHaveBeenCalledOnce(), { timeout: 5_000 });
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe("MCP HTTP Host and Origin checks", () => {
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "http-test-client", version: "0.0.1" },
    },
  });

  let httpServer: HttpServer | undefined;
  let chiasmusHome: string | undefined;
  let port = 0;

  async function start(allowedHosts?: string[]): Promise<void> {
    chiasmusHome = await mkdtemp(join(tmpdir(), "chiasmus-http-hosts-"));
    httpServer = await startChiasmusHttpServer({
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      sessionTtlMs: 30_000,
      chiasmusHome,
      allowedHosts,
    });
    port = (httpServer.address() as AddressInfo).port;
  }

  /**
   * Sends one request to the server with exactly these headers. fetch picks
   * the Host header itself, so a rebound page's request can't be built with it.
   */
  function send(path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
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

  afterEach(async () => {
    vi.restoreAllMocks();
    const server = httpServer;
    httpServer = undefined;
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    if (chiasmusHome) await rm(chiasmusHome, { recursive: true, force: true });
    chiasmusHome = undefined;
  });

  it("refuses an initialize sent under another site's hostname, before it starts a session", async () => {
    // A DNS-rebound page reaches 127.0.0.1, but its browser names the page's
    // own site in Host.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const create = vi.spyOn(SkillLibrary, "create");
    await start();

    const res = await send("/mcp", { host: `rebind.example:${port}` }, initialize);

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.message).toBe(`Invalid Host header: rebind.example:${port}`);
    expect(create).not.toHaveBeenCalled();
    expect((await send("/healthz", { host: `rebind.example:${port}` })).status).toBe(403);
    expect(JSON.parse((await send("/healthz", { host: `127.0.0.1:${port}` })).body)).toMatchObject({ sessions: 0 });
  });

  it("refuses a Host that only names a loopback address after credentials", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await start();

    expect((await send("/healthz", { host: `rebind.example@127.0.0.1:${port}` })).status).toBe(403);
  });

  it("refuses a request from a page on another site, before it starts a session", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const create = vi.spyOn(SkillLibrary, "create");
    await start();
    const host = `127.0.0.1:${port}`;

    const other = await send("/mcp", { host, origin: "http://rebind.example" }, initialize);
    const opaque = await send("/mcp", { host, origin: "null" }, initialize);

    expect(other.status).toBe(403);
    expect(JSON.parse(other.body).error.message).toBe("Invalid Origin header: http://rebind.example");
    expect(opaque.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("serves the loopback hostnames, and a page served from one", async () => {
    await start();

    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
      expect((await send("/healthz", { host })).status, host).toBe(200);
    }
    const res = await send("/mcp", { host: `localhost:${port}`, origin: "http://localhost:6274" }, initialize);
    expect(res.status).toBe(200);
  });

  it("serves a hostname given in allowedHosts as well as the loopback ones", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await start(["chiasmus.internal"]);

    expect((await send("/healthz", { host: `chiasmus.internal:${port}` })).status).toBe(200);
    expect((await send("/healthz", { host: `localhost:${port}` })).status).toBe(200);
    expect((await send("/healthz", { host: `rebind.example:${port}` })).status).toBe(403);
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
  type Shutdown = {
    url: URL;
    /** Runs the server's SIGTERM handler. */
    sigterm: () => void;
    /** Lets the graph pool's close() resolve. */
    release: () => void;
    poolClose: MockInstance;
    exit: MockInstance;
    httpServer: HttpServer;
  };

  /**
   * Runs `body` against a server whose shutdown can be watched part way:
   * process.exit is stubbed, and the graph pool's close() stays pending until
   * `release()`, as it does while a killed graph child is being reaped.
   */
  async function withShutdown(body: (s: Shutdown) => Promise<void>): Promise<void> {
    let release: (() => void) | undefined;
    const poolClose = vi.spyOn(GraphChildPool.prototype, "close")
      .mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const chiasmusHome = await mkdtemp(join(tmpdir(), "chiasmus-http-shutdown-"));
    const earlier = { SIGTERM: new Set(process.listeners("SIGTERM")), SIGINT: new Set(process.listeners("SIGINT")) };
    let httpServer: HttpServer | undefined;
    let signalled = false;
    try {
      httpServer = await startChiasmusHttpServer({ host: "127.0.0.1", port: 0, path: "/mcp", sessionTtlMs: 30_000, chiasmusHome });
      const onSigterm = process.listeners("SIGTERM").find((l) => !earlier.SIGTERM.has(l));
      expect(onSigterm).toBeDefined();
      const { port } = httpServer.address() as AddressInfo;
      await body({
        url: new URL(`http://127.0.0.1:${port}/mcp`),
        sigterm: () => {
          signalled = true;
          onSigterm!("SIGTERM");
        },
        release: () => release!(),
        poolClose,
        exit,
        httpServer,
      });
    } finally {
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        for (const l of process.listeners(signal)) if (!earlier[signal].has(l)) process.removeListener(signal, l);
      }
      release?.();
      if (httpServer) {
        const closed = new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        httpServer.closeAllConnections();
        await closed;
      }
      // A shutdown that a failed test left under way must end in the stub,
      // not in the real process.exit.
      if (signalled) await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 5_000 }).catch(() => undefined);
      vi.restoreAllMocks();
      await rm(chiasmusHome, { recursive: true, force: true });
    }
  }

  it("kills the graph child process before exiting on SIGTERM", async () => {
    await withShutdown(async ({ sigterm, release, poolClose, exit }) => {
      sigterm();

      await vi.waitFor(() => expect(poolClose).toHaveBeenCalledOnce());
      expect(exit).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    });
  });

  it("refuses a client that connects while it shuts down, and still exits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withShutdown(async ({ url, sigterm, release, poolClose, exit }) => {
      // A session open when the signal arrives, with its GET stream.
      const open = new Client({ name: "http-test-client", version: "0.0.1" });
      const late = new Client({ name: "http-test-client", version: "0.0.1" });
      try {
        await open.connect(new StreamableHTTPClientTransport(url));
        sigterm();
        await vi.waitFor(() => expect(poolClose).toHaveBeenCalledOnce());

        // The graph child is still being reaped. A session started now would
        // be missed by the shutdown, and its GET stream would hold the
        // server open until the client went away.
        await expect(late.connect(new StreamableHTTPClientTransport(url))).rejects.toThrow();
        release();
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143), { timeout: 5_000 });
      } finally {
        await late.close().catch(() => undefined);
        await open.close().catch(() => undefined);
      }
    });
  });

  it("answers 503 on a connection that was busy when the shutdown began, and closes a session that started then", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const libraryClose = vi.spyOn(SkillLibrary.prototype, "close");
    await withShutdown(async ({ url, sigterm, release, poolClose, exit, httpServer }) => {
      const initialize = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "http-test-client", version: "0.0.1" },
        },
      });
      const post = (connection: string) => [
        `POST ${url.pathname} HTTP/1.1`,
        `Host: ${url.host}`,
        "Content-Type: application/json",
        "Accept: application/json, text/event-stream",
        `Content-Length: ${Buffer.byteLength(initialize)}`,
        `Connection: ${connection}`,
        "",
        "",
      ].join("\r\n");
      const arrived = new Promise<void>((resolve) => httpServer.once("request", () => resolve()));
      const socket = connect(Number(url.port), url.hostname);
      let received = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => { received += chunk; });
      const statuses = () => [...received.matchAll(/^HTTP\/1\.1 (\d{3})/gm)].map((m) => Number(m[1]));
      try {
        // An initialize whose headers are in and whose body is still on its
        // way when the signal arrives: the request is past the shutdown check.
        socket.write(post("keep-alive") + initialize.slice(0, 10));
        await arrived;
        sigterm();
        await vi.waitFor(() => expect(poolClose).toHaveBeenCalledOnce());

        // Its body, then a second initialize on the same connection.
        socket.write(initialize.slice(10) + post("close") + initialize);
        await vi.waitFor(() => expect(statuses()).toEqual([200, 503]), { timeout: 5_000 });

        // The first initialize registered a session after the shutdown had
        // closed the open ones; it is closed before the exit.
        release();
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143), { timeout: 5_000 });
        expect(libraryClose).toHaveBeenCalledOnce();
      } finally {
        socket.destroy();
      }
    });
  });
});
