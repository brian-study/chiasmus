import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHttpOptions, startChiasmusHttpServer } from "../src/mcp-http-server.js";
import { SkillLibrary } from "../src/skills/library.js";

describe("Chiasmus Streamable HTTP MCP server", () => {
  it("parses CLI and env options", () => {
    const options = parseHttpOptions(
      [
        "--host", "localhost",
        "--port", "4949",
        "--path", "rpc",
        "--session-ttl-ms", "1000",
        "--chiasmus-home", "/tmp/chiasmus",
      ],
      {},
    );

    expect(options).toEqual({
      host: "localhost",
      port: 4949,
      path: "/rpc",
      sessionTtlMs: 1000,
      chiasmusHome: "/tmp/chiasmus",
    });
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
    expect(serverClose).toHaveBeenCalledOnce();
    expect(libraryClose).toHaveBeenCalledOnce();
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
    expect(serverClose).toHaveBeenCalledOnce();
    expect(libraryClose).toHaveBeenCalledOnce();
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
    expect(serverClose).toHaveBeenCalledOnce();
    expect(libraryClose).toHaveBeenCalledOnce();
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
      expect(libraryClose).toHaveBeenCalledOnce();
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
