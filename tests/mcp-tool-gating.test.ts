import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChiasmusServer } from "../src/mcp-server.js";
import { MockLLMAdapter, MockEmbeddingAdapter } from "../src/llm/mock.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMAdapter, EmbeddingAdapter } from "../src/llm/types.js";

// Verifies capability gating of the ListTools response: tools whose required
// backend isn't configured are not advertised to the model, so it never wastes
// a turn calling a tool that can only return a "not configured" error.
describe("MCP tool gating by configured capability", () => {
  let tempDir: string;
  let teardown: Array<() => Promise<void> | void> = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chiasmus-gating-"));
    teardown = [];
  });

  afterEach(async () => {
    for (const fn of teardown.reverse()) await fn();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function listToolNames(
    llm: LLMAdapter | null,
    embedding: EmbeddingAdapter | null,
  ): Promise<string[]> {
    const { server, library } = await createChiasmusServer(tempDir, llm, embedding);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientT);
    teardown.push(async () => {
      await client.close();
      await server.close();
      library.close();
    });
    const list = await client.listTools();
    return list.tools.map((t) => t.name);
  }

  it("hides chiasmus_search when no embedding provider is configured", async () => {
    const names = await listToolNames(new MockLLMAdapter(), null);
    expect(names).not.toContain("chiasmus_search");
  });

  it("lists chiasmus_search when an embedding provider is configured", async () => {
    const names = await listToolNames(
      new MockLLMAdapter(),
      new MockEmbeddingAdapter({ dimension: 8 }),
    );
    expect(names).toContain("chiasmus_search");
  });

  it("hides chiasmus_learn when no LLM is configured", async () => {
    const names = await listToolNames(null, new MockEmbeddingAdapter({ dimension: 8 }));
    expect(names).not.toContain("chiasmus_learn");
  });

  it("keeps gracefully-degrading tools (solve, formalize) listed without an LLM", async () => {
    const names = await listToolNames(null, new MockEmbeddingAdapter({ dimension: 8 }));
    expect(names).toContain("chiasmus_solve");
    expect(names).toContain("chiasmus_formalize");
  });

  it("always lists capability-independent tools (graph, map)", async () => {
    const names = await listToolNames(null, null);
    expect(names).toContain("chiasmus_graph");
    expect(names).toContain("chiasmus_map");
  });
});
