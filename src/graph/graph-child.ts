/**
 * Child-process entry for chiasmus_graph / chiasmus_map (see child-pool.ts).
 * Runs each job in the parent's working directory and environment, and
 * reports whether it left web-tree-sitter in a fatal state.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { serveJobs } from "../child/serve.js";
import { discoverAdapters } from "./adapter-registry.js";
import { wasmFailure } from "./parser.js";
import { handleGraph, handleMap } from "./tool-handlers.js";
import type { GraphJobMessage } from "./child-pool.js";

/** Run the job in the parent's working directory and environment, as an inline call would. */
function adoptParentContext(msg: GraphJobMessage): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in msg.env)) delete process.env[key];
  }
  Object.assign(process.env, msg.env);
  if (msg.cwd) process.chdir(msg.cwd);
}

serveJobs<GraphJobMessage, CallToolResult>(async (msg) => {
  let result: CallToolResult;
  try {
    adoptParentContext(msg);
    if (msg.discoverAdapters) await discoverAdapters();
    result = msg.tool === "chiasmus_map" ? await handleMap(msg.args) : await handleGraph(msg.args);
  } catch (e) {
    // The handlers catch their own errors; this is a last-resort net with
    // the same `{ error }` shape.
    result = { content: [{ type: "text", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }] };
  }
  return { result, fatal: wasmFailure() ?? undefined };
});
