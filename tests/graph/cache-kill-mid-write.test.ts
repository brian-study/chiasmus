import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultRepoKey, resolveCachePaths } from "../../src/graph/cache.js";
import { handleGraph } from "../../src/graph/tool-handlers.js";
import { GraphChildPool, childEntryFor } from "../../src/graph/child-pool.js";

const HOOK = fileURLToPath(new URL("./fixtures/pause-cache-write.mjs", import.meta.url));

function text(r: { content: unknown }): string {
  return (r.content as Array<{ text: string }>)[0].text;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function isJson(path: string): boolean {
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return true;
  } catch {
    return false;
  }
}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]);
}

/**
 * The pool stops a graph job by SIGKILLing its child, which may be in the
 * middle of writing the per-file cache, the manifest or a snapshot, and may
 * hold the cache lock. None of that may break a later run: every cache file
 * is written to a temp name and renamed into place, readers never look at
 * temp names, and the lock goes stale. Each case pauses the real child halfway
 * through one write, kills it through the pool's cancellation path, and runs
 * the same job again.
 */
describe("killing the graph child mid cache write", () => {
  let root: string;
  let files: string[];
  let pool: GraphChildPool;
  let repoDir: string;
  let lockDir: string;
  let expected: string;
  let prevCacheDir: string | undefined;
  let kills = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-cache-kill-"));
    prevCacheDir = process.env.CHIASMUS_CACHE_DIR;
    process.env.CHIASMUS_CACHE_DIR = join(root, "cache");
    const paths = resolveCachePaths({ cacheDir: join(root, "cache"), repoKey: defaultRepoKey() });
    repoDir = paths.repoDir;
    lockDir = `${paths.lockPath}.lock`;
    files = [];
    for (let f = 0; f < 30; f++) {
      const p = join(root, `m${f}.ts`);
      await writeFile(p, `export function f${f}(a: number) { return f${(f + 1) % 30}(a) + g${f}(a); }\nfunction g${f}(a: number) { return a; }\n`);
      files.push(p);
    }
    expected = text(await handleGraph({ files, analysis: "facts" }));
    const loaders = childEntryFor(new URL("../../src/graph/child-pool.ts", import.meta.url).href, process.execArgv);
    pool = new GraphChildPool({ execArgv: [...loaders.execArgv, "--import", pathToFileURL(HOOK).href] });
  });

  afterAll(async () => {
    try {
      await pool.close();
    } finally {
      if (prevCacheDir === undefined) delete process.env.CHIASMUS_CACHE_DIR;
      else process.env.CHIASMUS_CACHE_DIR = prevCacheDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  /** Run `args` in the child, pause the first write to a path containing `match`, kill the child there. */
  async function killMidWrite(match: string, args: Record<string, unknown>): Promise<string> {
    const marker = join(root, `paused-${++kills}`);
    process.env.CHIASMUS_TEST_PAUSE_WRITE = match;
    process.env.CHIASMUS_TEST_PAUSE_MARKER = marker;
    try {
      const ac = new AbortController();
      const job = pool.run({ tool: "chiasmus_graph", args, signal: ac.signal });
      await until(() => existsSync(marker), 20_000);
      const pid = pool.pid!;
      ac.abort();
      expect(JSON.parse(text(await job)).error).toBe("chiasmus_graph was cancelled by the client");
      await until(() => !alive(pid), 10_000);
      return readFileSync(marker, "utf8");
    } finally {
      delete process.env.CHIASMUS_TEST_PAUSE_WRITE;
      delete process.env.CHIASMUS_TEST_PAUSE_MARKER;
    }
  }

  /** What a reader could ever see: every non-temp cache file parses. */
  function expectNoTornCacheFile(): void {
    for (const p of filesUnder(repoDir)) {
      if (p.endsWith(".json")) expect(isJson(p), p).toBe(true);
    }
  }

  /** Facts as a set: a partly cached run lists the re-extracted files last. */
  function factSet(out: string): string[] {
    return (JSON.parse(out).result as string).split("\n").sort();
  }

  /**
   * The same cached job again, in a fresh child: the same facts, the dead
   * child's lock taken over, and a cache that then serves the whole job
   * byte-identically to a cold run.
   */
  async function expectCleanRerun(extra: Record<string, unknown> = {}): Promise<void> {
    const args = { files, analysis: "facts", cache: true };
    const t0 = performance.now();
    const rerun = text(await pool.run({ tool: "chiasmus_graph", args: { ...args, ...extra } }));
    // proper-lockfile treats a lock as stale 5 s after its holder last
    // refreshed it, so the rerun waits up to 5 s, plus a fresh child's
    // start. A lock that never went stale would fail the save once the
    // retries run out (about 9 s) and the rerun would return an error, not
    // facts; the bound leaves room for a loaded host.
    expect(performance.now() - t0).toBeLessThan(20_000);
    expect(factSet(rerun)).toEqual(factSet(expected));
    expect(existsSync(lockDir)).toBe(false);
    // Rewriting the same entries renamed the half-written temp file away.
    expect(filesUnder(repoDir).filter((p) => p.endsWith(".tmp"))).toEqual([]);
    expectNoTornCacheFile();
    expect(text(await pool.run({ tool: "chiasmus_graph", args }))).toBe(expected);
  }

  it("while writing per-file entries, holding the lock", async () => {
    const tmp = await killMidWrite(`${sep}files${sep}`, { files, analysis: "facts", cache: true });
    expect(tmp.endsWith(".json.tmp")).toBe(true);
    expect(isJson(tmp)).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
    expectNoTornCacheFile();
    await expectCleanRerun();
  }, 60_000);

  it("while writing the manifest, holding the lock", async () => {
    // Change one file so the save has something to write.
    await writeFile(files[0], `${readFileSync(files[0], "utf8")}export function extra() {}\n`);
    expected = text(await handleGraph({ files, analysis: "facts" }));
    const tmp = await killMidWrite("manifest.json.tmp", { files, analysis: "facts", cache: true });
    expect(isJson(tmp)).toBe(false);
    expect(existsSync(lockDir)).toBe(true);
    expect(isJson(join(repoDir, "manifest.json"))).toBe(true);
    expectNoTornCacheFile();
    await expectCleanRerun();
  }, 60_000);

  it("while writing a snapshot", async () => {
    const tmp = await killMidWrite(`${sep}snapshots${sep}`, { files, analysis: "facts", cache: true, save_snapshot: "base" });
    expect(isJson(tmp)).toBe(false);
    expectNoTornCacheFile();
    // The snapshot was never completed, so it does not exist (rather than being torn)...
    const diff = JSON.parse(text(await pool.run({
      tool: "chiasmus_graph", args: { files, analysis: "diff", against: "base", cache: true },
    })));
    expect(diff.result.error).toBe("Snapshot 'base' not found. Save one first via saveSnapshot.");
    // ...and saving it again works.
    await expectCleanRerun({ save_snapshot: "base" });
    const again = JSON.parse(text(await pool.run({
      tool: "chiasmus_graph", args: { files, analysis: "diff", against: "base", cache: true },
    })));
    expect(again.result.error).toBeUndefined();
  }, 60_000);
});
