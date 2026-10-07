import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/close-busy-pool.ts", import.meta.url));

interface FixtureRun {
  code: number | string;
  stderr: string;
  report: { outcome: string; terminateCalls: number; closeMs: number } | null;
}

async function closeBusyPool(files: string[], env: Record<string, string> = {}): Promise<FixtureRun> {
  let stdout = "";
  let stderr = "";
  let code: number | string = 0;
  try {
    ({ stdout, stderr } = await run(process.execPath, ["--import", "tsx", FIXTURE, files[0], ...files], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (e) {
    const err = e as { code?: number | string; signal?: string; stdout?: string; stderr?: string };
    code = err.signal ?? err.code ?? "unknown";
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
  }
  let report: FixtureRun["report"] = null;
  try {
    report = JSON.parse(stdout.trim());
  } catch {
    // reported below through the assertions
  }
  return { code, stderr, report };
}

/**
 * worker.terminate() — and process.exit() — while the graph worker is inside
 * native tree-sitter makes node-addon-api throw a Napi::Error that escapes
 * ("terminate called after throwing an instance of 'Napi::Error'") and
 * aborts the whole process, server included. Retiring a busy worker must
 * stop it cooperatively between files instead.
 */
describe("closing the pool while the worker is busy", () => {
  let root: string;
  let tsFiles: string[];
  let cljFiles: string[];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-close-busy-"));
    tsFiles = [];
    for (let f = 0; f < 300; f++) {
      let src = "";
      for (let i = 0; i < 40; i++) {
        src += `export function f${f}_${i}(a: number): number { return g${i}(a) + h${f}(a, ${i}); }\n`;
      }
      const p = join(root, `m${f}.ts`);
      await writeFile(p, src);
      tsFiles.push(p);
    }
    // ~10 MB of Clojure: WASM-grammar extraction still running when close()
    // lands; the worker stops within milliseconds.
    cljFiles = [];
    for (let f = 0; f < 1200; f++) {
      let src = `(ns app.m${f}\n  (:require [app.m${(f + 1) % 1200} :as next]))\n`;
      for (let i = 0; i < 60; i++) {
        src += `(defn f${f}-${i} [a b]\n  (let [x (next/f${(f + 1) % 1200}-${i} a b)]\n    (+ x (g${i} a) (h${f} b ${i}))))\n`;
      }
      const p = join(root, `m${f}.clj`);
      await writeFile(p, src);
      cljFiles.push(p);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stops a worker inside native extraction without terminate() or an abort", async () => {
    // Grace far above any cooperative stop: a terminate() call means the
    // cooperative path broke, deterministically — whereas whether an early
    // terminate() happens to land inside native code (and abort) is luck.
    const r = await closeBusyPool(tsFiles);
    expect(r.stderr).not.toMatch(/Napi::Error|terminate called/);
    expect(r.code).toBe(0);
    expect(r.report).toMatchObject({ outcome: "closed-mid-job", terminateCalls: 0 });
  }, 120_000);

  it("stops a worker parsing WASM grammars (Clojure) within the grace period", async () => {
    // These files parse after an await (the grammar load); the cancel flag
    // must still stop the batch within the grace period, or the pool falls
    // back to terminate().
    const r = await closeBusyPool(cljFiles, { CANCEL_GRACE_MS: "1000" });
    expect(r.code).toBe(0);
    expect(r.report).toMatchObject({ outcome: "closed-mid-job", terminateCalls: 0 });
    expect(r.report!.closeMs).toBeLessThan(1_000);
  }, 120_000);
});
