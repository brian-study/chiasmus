// Child-process fixture for worker-shutdown.test.ts: start a heavy
// chiasmus_map on the real graph worker, then close the pool while the worker
// is inside extraction. Runs out of process because the failure mode is a
// C++ abort that would take the test runner down with it.
import { Worker } from "node:worker_threads";
import { GraphWorkerPool } from "../../../src/graph/worker-pool.js";

// The pool must stop a busy worker cooperatively. Whether a terminate()
// lands inside native code (and aborts) is down to timing; whether the pool
// called it at all is not.
let terminateCalls = 0;
const terminate = Worker.prototype.terminate;
Worker.prototype.terminate = function (this: Worker) {
  terminateCalls++;
  return terminate.call(this);
};

const [warmup, ...files] = process.argv.slice(2);
const pool = new GraphWorkerPool({ cancelGraceMs: Number(process.env.CANCEL_GRACE_MS ?? 30_000) });
// Warm-up job: worker started, grammars loaded, so the heavy job below is
// already extracting when close() lands.
await pool.run({ tool: "chiasmus_graph", args: { files: [warmup], analysis: "summary" } });
const job = pool.run({ tool: "chiasmus_map", args: { files } });
await new Promise((r) => setTimeout(r, Number(process.env.CLOSE_AFTER_MS ?? 300)));
const t0 = performance.now();
await pool.close();
const closeMs = Math.round(performance.now() - t0);
const text = ((await job).content as Array<{ text: string }>)[0].text;
const outcome = text.includes("graph worker pool is shut down") ? "closed-mid-job" : "job-finished-first";
console.log(JSON.stringify({ outcome, terminateCalls, closeMs }));
