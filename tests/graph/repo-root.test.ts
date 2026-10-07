import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commonPathAncestor, findRepoRoot } from "../../src/graph/repo-root.js";
import { defaultRepoKey, repoKeyForFiles } from "../../src/graph/cache.js";

describe("findRepoRoot / repoKeyForFiles", () => {
  let root: string;
  let repoA: string;
  let repoB: string;
  let worktree: string;
  let plain: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "chiasmus-repo-root-"));
    repoA = join(root, "repo-a");
    repoB = join(root, "repo-b");
    worktree = join(root, "wt");
    plain = join(root, "plain");
    for (const repo of [repoA, repoB]) {
      await mkdir(join(repo, ".git"), { recursive: true });
      await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    await mkdir(join(repoA, "src", "deep"), { recursive: true });
    await mkdir(join(repoA, "lib"), { recursive: true });
    await mkdir(join(repoB, "src"), { recursive: true });
    // Worktrees and submodules carry a `.git` *file* pointing at the gitdir.
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    await mkdir(join(plain, "x"), { recursive: true });
    await mkdir(join(plain, "y"), { recursive: true });
    // An empty `.git` directory is not a repository to git.
    await mkdir(join(plain, ".git"), { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("commonPathAncestor keeps its existing semantics", () => {
    expect(commonPathAncestor([])).toBe("/");
    expect(commonPathAncestor(["/a/b/c.ts"])).toBe("/a/b");
    expect(commonPathAncestor(["/a/b/c.ts", "/a/d/e.ts"])).toBe("/a");
    expect(commonPathAncestor(["/x/1.ts", "/y/2.ts"])).toBe("/");
  });

  it("returns the git toplevel above the files' common ancestor", () => {
    expect(findRepoRoot([join(repoA, "src", "deep", "x.ts")])).toBe(repoA);
    expect(findRepoRoot([join(repoA, "src", "x.ts"), join(repoA, "lib", "y.ts")])).toBe(repoA);
    expect(findRepoRoot([join(repoA, "src", "x.ts"), join(repoA, "src", "x.ts")])).toBe(repoA);
  });

  it("treats a .git file (worktree/submodule) as a repository root", () => {
    expect(findRepoRoot([join(worktree, "src", "x.ts")])).toBe(worktree);
  });

  it("falls back to the common ancestor directory outside git", () => {
    // `plain/.git` exists but is empty, so the walk passes over it.
    expect(findRepoRoot([join(plain, "x", "1.ts"), join(plain, "y", "2.ts")])).toBe(plain);
    expect(findRepoRoot([join(plain, "x", "1.ts")])).toBe(join(plain, "x"));
  });

  it("gives each repository its own key and one key per repository", () => {
    const a1 = repoKeyForFiles([join(repoA, "src", "x.ts")]);
    const a2 = repoKeyForFiles([join(repoA, "lib", "y.ts"), join(repoA, "src", "deep", "z.ts")]);
    const b = repoKeyForFiles([join(repoB, "src", "x.ts")]);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("never reuses a bucket written under the old cwd-derived key", () => {
    // Even when the analysed repo is the server's cwd, the old shared bucket
    // (which mixed every repo's snapshots) must miss.
    expect(repoKeyForFiles([join(repoA, "src", "x.ts")])).not.toBe(defaultRepoKey(repoA));
  });
});
