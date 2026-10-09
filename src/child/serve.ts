/**
 * The child-process side of ChildPool (./pool.ts): runs the jobs the parent
 * sends, one at a time, and replies with each result, whether the job left a
 * WASM module in a fatal state, and this process's RSS, so the parent can
 * decide whether to reuse it. The parent stops a job by killing this
 * process; nothing here needs a clean exit.
 *
 * argv[2] is the parent's PID.
 */

import { Worker } from "node:worker_threads";
import type { JobMessage, ResultMessage } from "./pool.js";

// This process must not outlive the parent. When the parent dies its end of
// the IPC channel closes: an idle child gets 'disconnect' and exits. A busy
// one would only see it once its current synchronous step returns (a tree
// walk or a Prolog query can take seconds), so a watchdog thread checks for
// the parent every 500 ms and SIGKILLs this process once it is gone. On
// POSIX a dead parent shows as a changed ppid (the child is re-parented); on
// Windows ppid stays put, so the watchdog also probes the parent's PID.
const WATCHDOG = `
const { workerData: { parentPid } } = require("node:worker_threads");
function parentGone() {
  if (process.ppid !== parentPid) return true;
  try {
    process.kill(parentPid, 0);
    return false;
  } catch {
    return true;
  }
}
setInterval(() => { if (parentGone()) process.kill(process.pid, "SIGKILL"); }, 500);
`;

/**
 * Serve the parent's jobs with `run`, which handles its own errors: a
 * rejection is an unhandled one, and ends this process like a crash.
 */
export function serveJobs<M extends JobMessage, R>(
  run: (msg: M) => Promise<{ result: R; fatal?: string }>,
): void {
  if (!process.send) throw new Error("a child entry must be started with child_process.fork()");
  const parentPid = Number(process.argv[2]);

  const send = (message: ResultMessage<R>): void => {
    // The channel only closes when the parent is gone.
    process.send!(message, undefined, undefined, (err: Error | null) => {
      if (err) process.exit(0);
    });
  };

  process.on("disconnect", () => process.exit(0));
  if (Number.isInteger(parentPid) && parentPid > 0) {
    new Worker(WATCHDOG, { eval: true, workerData: { parentPid }, execArgv: [] }).unref();
  }

  process.on("message", (msg: M) => {
    if (msg?.type !== "job") return;
    void run(msg).then(({ result, fatal }) => {
      send({ type: "result", id: msg.id, result, fatal, rssBytes: process.memoryUsage.rss() });
    });
  });
}
