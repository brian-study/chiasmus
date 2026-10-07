import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Longest common absolute-path prefix across the given paths. */
export function commonPathAncestor(paths: string[]): string {
  if (paths.length === 0) return "/";
  const parts = paths.map((p) => p.split("/").filter(Boolean));
  if (parts.length === 1) {
    const p = [...parts[0]];
    p.pop();
    return "/" + p.join("/");
  }
  let i = 0;
  const min = Math.min(...parts.map((p) => p.length));
  while (i < min) {
    const seg = parts[0][i];
    if (!parts.every((p) => p[i] === seg)) break;
    i++;
  }
  return "/" + parts[0].slice(0, i).join("/");
}

/**
 * Root of the repository the given files belong to: the nearest ancestor of
 * their common directory that git would treat as a worktree top — what
 * `git rev-parse --show-toplevel` reports — else the common directory.
 */
export function findRepoRoot(paths: string[]): string {
  let start = commonPathAncestor(paths);
  // Every path naming the same file leaves the file itself as the prefix.
  if (paths.includes(start)) start = dirname(start);
  for (let dir = start; ; dir = dirname(dir)) {
    if (hasGitDir(dir)) return dir;
    if (dirname(dir) === dir) return start;
  }
}

/**
 * A `.git` directory with a HEAD, or a `.git` file holding a `gitdir:`
 * pointer (worktrees, submodules). A bare empty `.git` directory is not a
 * repository to git, so it isn't one here either.
 */
function hasGitDir(dir: string): boolean {
  const dotGit = join(dir, ".git");
  try {
    const st = statSync(dotGit);
    if (st.isDirectory()) return statSync(join(dotGit, "HEAD")).isFile();
    if (st.isFile()) return readFileSync(dotGit, "utf-8").startsWith("gitdir:");
  } catch {
    // Missing entry, or a .git directory without HEAD.
  }
  return false;
}
