// Stand-in for src/graph/graph-worker.ts speaking the same message protocol,
// so GraphWorkerPool's lifecycle (persistence, recycling, timeouts, queueing)
// can be driven deterministically. `args.mode` picks the behaviour.
import { parentPort, threadId } from "node:worker_threads";

let jobs = 0;

function reply(id, payload, extra = {}) {
  parentPort.postMessage({
    type: "result",
    id,
    result: { content: [{ type: "text", text: JSON.stringify({ threadId, jobs, ...payload }) }] },
    memoryBytes: 0,
    ...extra,
  });
}

parentPort.on("message", async (msg) => {
  if (msg.type !== "job") return;
  jobs++;
  const { mode = "ok", ms = 0, bytes = 0, name } = msg.args;
  const startedAt = Date.now();
  switch (mode) {
    case "ok":
      return reply(msg.id, { mode, tool: msg.tool, discoverAdapters: msg.discoverAdapters });
    case "sleep":
      await new Promise((r) => setTimeout(r, ms));
      return reply(msg.id, { mode, startedAt, endedAt: Date.now() });
    case "env":
      return reply(msg.id, { value: process.env[name] ?? null });
    case "crash":
      setImmediate(() => {
        throw new Error("boom");
      });
      return;
    case "exit":
      process.exit(3);
      return;
    case "fatal":
      return reply(msg.id, { error: "memory access out of bounds" }, { fatal: "memory access out of bounds" });
    case "memory":
      return reply(msg.id, { mode }, { memoryBytes: bytes });
    case "hang":
      for (;;) {
        // Busy loop: only terminate() can stop this.
      }
    case "oom": {
      const hoard = [];
      for (;;) hoard.push(new Array(1_000_000).fill(hoard.length));
    }
    default:
      return reply(msg.id, { error: `unknown mode ${mode}` });
  }
});
