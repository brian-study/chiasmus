import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChiasmusServer } from "../src/mcp-server.js";
import { SkillLibrary } from "../src/skills/library.js";
import { MockLLMAdapter } from "../src/llm/mock.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// chiasmus_learn stored whatever template the LLM returned for a verified
// spec, with no check that the template still says what the spec said, and
// formalize/solve picked it up straight away. It is retired; templates are
// added through chiasmus_craft, which validates them. These tests hold that
// no LLM response can reach the library through the old tool name.
describe("chiasmus_learn is retired", () => {
  let tempDir: string;
  let teardown: Array<() => Promise<void> | void> = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chiasmus-learn-retired-"));
    teardown = [];
  });

  afterEach(async () => {
    for (const fn of teardown.reverse()) await fn();
    await rm(tempDir, { recursive: true, force: true });
  });

  // An LLM that answers every prompt with a well-formed template whose
  // cycle rule only sees two-node cycles, so it never fires on the
  // three-node graph it was learned from. The learner would have stored it.
  function templateLLM(): MockLLMAdapter {
    const llm = new MockLLMAdapter();
    llm.onMatch(/./, JSON.stringify({
      name: "three-edge-cycle",
      domain: "analysis",
      signature: "Detect a cycle in a dependency graph",
      slots: [{ name: "edge", description: "One edge", format: "edge(a, b)." }],
      normalizations: [{ source: "graph", transform: "one fact per edge" }],
      skeleton: "{{SLOT:edge}}\ncycle(X) :- edge(X, Y), edge(Y, X).",
    }));
    return llm;
  }

  async function connect() {
    const { server, library } = await createChiasmusServer(tempDir, templateLLM(), null);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientT);
    teardown.push(async () => {
      await client.close();
      await server.close();
      library.close();
    });
    return { client, library };
  }

  it("is not listed even when an LLM is configured", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("chiasmus_learn");
    expect(names).toContain("chiasmus_craft");
  });

  it("answers a call by name as an unknown tool and stores nothing", async () => {
    const { client, library } = await connect();
    const before = library.list().length;

    const result = await client.callTool({
      name: "chiasmus_learn",
      arguments: {
        solver: "prolog",
        spec: [
          "edge(a, b).", "edge(b, c).", "edge(c, a).",
          "reach(X, Y) :- edge(X, Y).",
          "reach(X, Z) :- edge(X, Y), reach(Y, Z).",
          "cycle(X) :- reach(X, X).",
        ].join("\n"),
        problem: "Find cycles in a three-node graph",
      },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual({ status: "error", error: "Unknown tool: chiasmus_learn" });

    expect(library.list().length).toBe(before);
    expect(library.get("three-edge-cycle")).toBeNull();

    // Nothing reached disk either: a fresh library over the same home sees
    // only what was there before.
    const reopened = await SkillLibrary.create(tempDir);
    try {
      expect(reopened.get("three-edge-cycle")).toBeNull();
    } finally {
      reopened.close();
    }
  });
});
