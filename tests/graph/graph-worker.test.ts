import { describe, it, expect, afterEach } from "vitest";
import { Worker } from "node:worker_threads";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerEntryFor, type GraphJobMessage, type GraphResultMessage } from "../../src/graph/worker-pool.js";

/**
 * The real worker entry (graph-worker.ts) speaking the pool's protocol. The
 * pool's recycling decisions are tested against a fake worker; this checks
 * the real one reports what those decisions read.
 */
describe("graph-worker protocol", () => {
  let worker: Worker | null = null;
  let root: string | null = null;

  afterEach(async () => {
    await worker?.terminate();
    worker = null;
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it("replies with the result, no fatal flag and the RSS at start and after the job", async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-graph-worker-"));
    const file = join(root, "a.ts");
    await writeFile(file, "export function a() { b(); }\nfunction b() {}\n");

    const entry = workerEntryFor(new URL("../../src/graph/worker-pool.ts", import.meta.url).href, process.execArgv);
    worker = new Worker(entry.url, {
      workerData: { cancel: new SharedArrayBuffer(4) },
      ...(entry.execArgv ? { execArgv: entry.execArgv } : {}),
    });
    const reply = new Promise<GraphResultMessage>((resolve, reject) => {
      worker!.once("message", resolve);
      worker!.once("error", reject);
    });
    const job: GraphJobMessage = {
      type: "job",
      id: 7,
      tool: "chiasmus_graph",
      args: { files: [file], analysis: "summary" },
      discoverAdapters: false,
    };
    worker.postMessage(job);
    const m = await reply;

    expect(m.type).toBe("result");
    expect(m.id).toBe(7);
    expect(m.fatal).toBeUndefined();
    const text = (m.result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text).result).toMatchObject({ files: 1, functions: 2 });
    // Whole-process figures: a Node process with a worker is well over 10 MB.
    expect(m.startRssBytes).toBeGreaterThan(10 * 1024 ** 2);
    expect(m.rssBytes).toBeGreaterThan(10 * 1024 ** 2);
  }, 60_000);
});
