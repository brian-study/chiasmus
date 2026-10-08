import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingAdapter } from "../src/llm/types.js";
import { startChiasmusHttpServer } from "../src/mcp-http-server.js";

// The daemon's embedding adapter, and the one each session is given.
const fake = vi.hoisted(() => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => [0, 1])),
  dispose: vi.fn(async () => undefined),
  passed: [] as Array<EmbeddingAdapter | null | undefined>,
}));

vi.mock("../src/llm/anthropic.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/anthropic.js")>()),
  createEmbeddingFromEnv: () => ({ embed: fake.embed, dimension: () => 2, dispose: fake.dispose }),
}));

vi.mock("../src/mcp-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/mcp-server.js")>();
  return {
    ...actual,
    createChiasmusServer: (...args: Parameters<typeof actual.createChiasmusServer>) => {
      fake.passed.push(args[2]);
      return actual.createChiasmusServer(...args);
    },
  };
});

describe("MCP HTTP shared embedding adapter", () => {
  it("gives every session one adapter, which refuses work once close() begins, and disposes the model", async () => {
    const home = await mkdtemp(join(tmpdir(), "chiasmus-http-embedding-"));
    const daemon = await startChiasmusHttpServer({
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      sessionTtlMs: 30_000,
      chiasmusHome: home,
    });
    try {
      const { port } = daemon.httpServer.address() as AddressInfo;
      for (let i = 0; i < 2; i++) {
        const client = new Client({ name: "http-test-client", version: "0.0.1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
        await client.close();
      }
      expect(fake.passed).toHaveLength(2);
      expect(fake.passed[0]).toBe(fake.passed[1]);
      const shared = fake.passed[0]!;
      expect(await shared.embed(["a"])).toEqual([[0, 1]]);

      await daemon.close();

      expect(fake.dispose).toHaveBeenCalledOnce();
      // A search still running after close() would load the model again.
      fake.embed.mockClear();
      await expect(shared.embed(["late search"])).rejects.toThrow("The MCP HTTP server has closed");
      expect(fake.embed).not.toHaveBeenCalled();
    } finally {
      await daemon.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
