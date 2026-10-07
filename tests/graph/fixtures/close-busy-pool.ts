// Child-process fixture for worker-shutdown.test.ts: start a heavy
// chiasmus_map on the real graph worker, then close the pool while the worker
// is inside native tree-sitter extraction. Runs out of process because the
// failure mode is a C++ abort that would take the test runner down with it.
import { GraphWorkerPool } from "../../../src/graph/worker-pool.js";

const [warmup, ...files] = process.argv.slice(2);
const pool = new GraphWorkerPool();
// Warm-up job: worker started, grammars loaded, so the heavy job below is
// already extracting when close() lands.
await pool.run({ tool: "chiasmus_graph", args: { files: [warmup], analysis: "summary" } });
const job = pool.run({ tool: "chiasmus_map", args: { files } });
await new Promise((r) => setTimeout(r, Number(process.env.CLOSE_AFTER_MS ?? 300)));
await pool.close();
const text = ((await job).content as Array<{ text: string }>)[0].text;
console.log(text.includes("graph worker pool is shut down") ? "closed-mid-job" : "job-finished-first");
