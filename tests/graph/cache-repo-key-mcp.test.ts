import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChiasmusServer } from "../../src/mcp-server.js";
import { defaultRepoKey } from "../../src/graph/cache.js";
import { MockLLMAdapter } from "../../src/llm/mock.js";
import { shutdownGraphWorkers } from "../../src/graph/worker-pool.js";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The graph cache (per-file entries + named snapshots) must be keyed by the
 * repository being analysed. It used to hash process.cwd() — always the
 * chiasmus checkout for the daemon — so every analysed repo shared one
 * bucket and a snapshot saved for repo A answered a diff for repo B.
 */
describe("graph cache keyed by analysed repo (MCP)", () => {
  let client: Client;
  let root: string;
  let cacheDir: string;
  let repoA: string;
  let repoB: string;
  let prevCacheDir: string | undefined;
  let cleanup: () => Promise<void>;

  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text: string }>)[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-repo-key-"));
    cacheDir = join(root, "cache");
    prevCacheDir = process.env.CHIASMUS_CACHE_DIR;
    process.env.CHIASMUS_CACHE_DIR = cacheDir;

    repoA = join(root, "repo-a");
    repoB = join(root, "repo-b");
    for (const repo of [repoA, repoB]) {
      await mkdir(join(repo, ".git"), { recursive: true });
      await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
      await mkdir(join(repo, "src"), { recursive: true });
      await mkdir(join(repo, "lib"), { recursive: true });
    }
    await writeFile(join(repoA, "src", "a.ts"), "export function alpha() { beta(); }\nfunction beta() {}\n");
    await writeFile(join(repoA, "lib", "c.ts"), "export function gamma() { alpha(); }\n");
    await writeFile(join(repoB, "src", "b.ts"), "export function delta() { epsilon(); }\nfunction epsilon() {}\n");

    const mockLLM = new MockLLMAdapter();
    mockLLM.onMatch(/./, "mock");
    const { server, library } = await createChiasmusServer(root, mockLLM);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);

    cleanup = async () => {
      await client.close();
      await server.close();
      library.close();
      await shutdownGraphWorkers();
    };
  });

  afterAll(async () => {
    try {
      await cleanup?.();
    } finally {
      if (prevCacheDir === undefined) delete process.env.CHIASMUS_CACHE_DIR;
      else process.env.CHIASMUS_CACHE_DIR = prevCacheDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a snapshot saved for repo A answer a diff for repo B", async () => {
    const saved = await call("chiasmus_graph", {
      files: [join(repoA, "src", "a.ts")],
      analysis: "summary",
      cache: true,
      save_snapshot: "main",
    });
    expect(saved.warnings).toBeUndefined();

    const diffB = await call("chiasmus_graph", {
      files: [join(repoB, "src", "b.ts")],
      analysis: "diff",
      against: "main",
    });
    expect(diffB.result.error).toMatch(/Snapshot 'main' not found/);

    const diffA = await call("chiasmus_graph", {
      files: [join(repoA, "src", "a.ts")],
      analysis: "diff",
      against: "main",
    });
    expect(diffA.result.error).toBeUndefined();
  });

  it("finds a snapshot from any subdirectory of the same repo", async () => {
    await call("chiasmus_graph", {
      files: [join(repoA, "src", "a.ts")],
      analysis: "summary",
      cache: true,
      save_snapshot: "sub",
    });
    const diff = await call("chiasmus_graph", {
      files: [join(repoA, "lib", "c.ts")],
      analysis: "diff",
      against: "sub",
    });
    expect(diff.result.error).toBeUndefined();
  });

  it("writes chiasmus_map cache entries outside the cwd-derived bucket", async () => {
    const out = await call("chiasmus_map", {
      files: [join(repoB, "src", "b.ts")],
      cache: true,
      format: "json",
    });
    expect(out.error).toBeUndefined();
    const buckets = readdirSync(cacheDir);
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets).not.toContain(defaultRepoKey());
    expect(existsSync(join(cacheDir, defaultRepoKey()))).toBe(false);
  });
});
