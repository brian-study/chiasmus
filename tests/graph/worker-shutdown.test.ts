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

/**
 * worker.terminate() — and process.exit() — while the graph worker is inside
 * native tree-sitter makes node-addon-api throw a Napi::Error that escapes
 * ("terminate called after throwing an instance of 'Napi::Error'") and
 * aborts the whole process, daemon included. Retiring a busy worker must
 * stop it cooperatively between files instead.
 */
describe("closing the pool while the worker is busy", () => {
  let root: string;
  let files: string[];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-close-busy-"));
    files = [];
    for (let f = 0; f < 300; f++) {
      let src = "";
      for (let i = 0; i < 40; i++) {
        src += `export function f${f}_${i}(a: number): number { return g${i}(a) + h${f}(a, ${i}); }\n`;
      }
      const p = join(root, `m${f}.ts`);
      await writeFile(p, src);
      files.push(p);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stops the worker without aborting the process", async () => {
    // Each attempt aborted 2 times in 3 before the fix; three attempts make
    // a lucky pass unlikely.
    for (let attempt = 0; attempt < 3; attempt++) {
      let stdout = "";
      let stderr = "";
      let code: number | string | null = 0;
      try {
        ({ stdout, stderr } = await run(process.execPath, ["--import", "tsx", FIXTURE, files[0], ...files], {
          cwd: REPO_ROOT,
          timeout: 90_000,
          maxBuffer: 16 * 1024 * 1024,
        }));
      } catch (e) {
        const err = e as { code?: number | string; signal?: string; stdout?: string; stderr?: string };
        code = err.signal ?? err.code ?? "unknown";
        stdout = err.stdout ?? "";
        stderr = err.stderr ?? "";
      }
      expect(stderr).not.toMatch(/Napi::Error|terminate called/);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe("closed-mid-job");
    }
  }, 240_000);
});
