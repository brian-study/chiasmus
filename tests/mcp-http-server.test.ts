import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHttpOptions, startChiasmusHttpServer } from "../src/mcp-http-server.js";

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
