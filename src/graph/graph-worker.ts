/**
 * Worker-thread entry for chiasmus_graph / chiasmus_map (see worker-pool.ts).
 * Runs one job at a time and reports, with each result, whether the job left
 * this thread's web-tree-sitter in a fatal state and the process RSS (now and
 * when this thread started), so the pool can decide whether to reuse it.
 */

import { parentPort, workerData } from "node:worker_threads";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { discoverAdapters } from "./adapter-registry.js";
import { setExtractionCheckpoint } from "./extractor.js";
import { wasmFailure } from "./parser.js";
import { handleGraph, handleMap } from "./tool-handlers.js";
import type { GraphResultMessage, GraphWorkerData, GraphWorkerMessage } from "./worker-pool.js";

if (!parentPort) throw new Error("graph-worker must run as a worker thread");
const port = parentPort;
const startRssBytes = process.memoryUsage.rss();

// Set by the pool when it retires this worker mid-job: the running job stops
// at the next file and the queued `exit` message then ends the thread from JS.
const cancelled = new Int32Array((workerData as GraphWorkerData).cancel);
setExtractionCheckpoint(() => {
  if (Atomics.load(cancelled, 0) !== 0) throw new Error("graph job cancelled: the graph worker is being retired");
});

port.on("message", async (msg: GraphWorkerMessage) => {
  if (msg?.type === "exit") process.exit(0);
  if (msg?.type !== "job") return;
  let result: CallToolResult;
  try {
    if (msg.discoverAdapters) await discoverAdapters();
    result = msg.tool === "chiasmus_map" ? await handleMap(msg.args) : await handleGraph(msg.args);
  } catch (e) {
    // The handlers catch their own errors; this is a last-resort net with
    // the same `{ error }` shape.
    result = { content: [{ type: "text", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] };
  }
  const reply: GraphResultMessage = {
    type: "result",
    id: msg.id,
    result,
    fatal: wasmFailure() ?? undefined,
    rssBytes: process.memoryUsage.rss(),
    startRssBytes,
  };
  port.postMessage(reply);
});
