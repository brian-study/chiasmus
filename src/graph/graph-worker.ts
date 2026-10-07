/**
 * Worker-thread entry for chiasmus_graph / chiasmus_map (see worker-pool.ts).
 * Runs one job at a time and reports, with each result, whether the job left
 * this thread's web-tree-sitter in a fatal state and how much memory the
 * isolate holds, so the pool can decide whether to reuse the thread.
 */

import { parentPort } from "node:worker_threads";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { discoverAdapters } from "./adapter-registry.js";
import { wasmFailure } from "./parser.js";
import { handleGraph, handleMap } from "./tool-handlers.js";
import type { GraphJobMessage, GraphResultMessage } from "./worker-pool.js";

if (!parentPort) throw new Error("graph-worker must run as a worker thread");
const port = parentPort;

port.on("message", async (msg: GraphJobMessage) => {
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
  const mem = process.memoryUsage();
  const reply: GraphResultMessage = {
    type: "result",
    id: msg.id,
    result,
    fatal: wasmFailure() ?? undefined,
    // WASM memories are ArrayBuffers. `external` is no use here: native
    // tree-sitter's accounting reported >100 GB transiently on a 4.5k-file map.
    memoryBytes: mem.heapUsed + mem.arrayBuffers,
  };
  port.postMessage(reply);
});
