# chiasmus — engine TODOs

Backlog for this fork (`brian-study/chiasmus`). Items tagged **[upstream]** are
fork-agnostic improvements worth a PR to `yogthos/chiasmus` (the contributor
guide is `AGENTS.md`; PR style follows yogthos/chiasmus#40–#43: a terse conventional-commit title
(`fix(scope): ...`), one commit per logical change, and a `## Problem`/`## Fix`/`## Tests`
body).

Context: this fork carries the lab harness's chiasmus-verification lane work — see
`harness-plugin/docs/plans/2026-06-08-chiasmus-verification-lane.md`.

## Synced to upstream 0.1.29 (2026-09-04)

The fork is merged with the upstream `main` published as 0.1.29. Four fixes
originating here are now upstream and the fork uses their upstream versions:
- ✅ **PR #34 (Err/EStr binding fix) MERGED** → upstream `a9826ec` (0.1.22).
- ✅ **Issue #35 (selector + fill) FIXED by upstream** → `3aadfea` (0.1.23/0.1.24).
  Upstream's fix is functionally identical to ours (optional `EmbeddingAdapter`
  cosine re-rank with BM25 fallback; `FORMALIZE_SYSTEM` "examples are FORM/SYNTAX
  only"; shared search-text helper). Our `fdf000b`/`d413cdb` dropped. Validated
  live on our daemon (the Azure embedding config drives the re-rank).

- ✅ **Issue #36 nits FIXED by us, MERGED upstream** → PR
  [#37](https://github.com/yogthos/chiasmus/pull/37), upstream merge `576ed38`
  (2026-06-08). `serverInfo.version` now sourced from `package.json`; `converged`
  documented as "loop ran" ≠ "property holds" at all 3 surfaces; the Prolog lint
  now checks clause termination. All three dropped from Open below.

- ✅ **Prolog WASM teardown corruption FIXED by us, MERGED upstream** → PR
  [#40](https://github.com/yogthos/chiasmus/pull/40), published as 0.1.29. The fix
  removes the blanket weak `library(lists)` import, namespaces the generated
  graph membership helper, and consults/tears down once per batch. The merged
  tree passes the collision-shaped regression and repeated in-process and live
  HTTP solver acceptance.

The fork-specific delta is the HTTP-daemon mode (`src/mcp-http-server.ts`), the
build-on-install prepare script, this TODO, and a package-version marker matching
the published release (upstream published 0.1.29 without committing that version
bump). Re-sync published `main` without rewriting it:

```bash
git fetch upstream
git switch main
git merge --no-edit upstream/main
```

## Daemon hang hardening (2026-10-07/08)

The daemon hang hardening (`fix/daemon-hang-hardening`, fork PR #1, closed) is
split into four **[upstream]** branches cut from `upstream/main` `55d4388` and
worded without fork references, plus a fork-only remainder. `main` gets them by
merging fork PRs #3, #6, #4 and #8 into `main` with merge commits, in that order
(`integration/daemon-hardening-v2` is exactly that), then the fork-only PR on
`fork/http-daemon-hardening-v2`.

- **[upstream] Z3 context leak** → `fix/z3-solve-context-leak`, fork PR
  [#3](https://github.com/brian-study/chiasmus/pull/3), upstream
  [yogthos/chiasmus#41](https://github.com/yogthos/chiasmus/pull/41), PENDING.
  Each solve deletes its own Z3 context; one leaked ~8.7 MB per verify call
  until the fixed 2 GiB WASM heap ran out after ~240 calls and Emscripten aborted.
- **[upstream] Exit after a solver WASM abort** → `fix/solver-wasm-abort-exit`,
  stacked on the context-leak branch, fork PR
  [#6](https://github.com/brian-study/chiasmus/pull/6), upstream
  [yogthos/chiasmus#43](https://github.com/yogthos/chiasmus/pull/43) (branch
  `fix/solver-wasm-abort-exit-upstream`, the same tree as one commit), PENDING.
  The solvers stop calling into a crashed module and the stdio entry exits 1
  instead of hanging.
- **[upstream] Bounded `bridges` betweenness** → `fix/bounded-bridges-betweenness`,
  fork PR [#4](https://github.com/brian-study/chiasmus/pull/4), upstream
  [yogthos/chiasmus#42](https://github.com/yogthos/chiasmus/pull/42), PENDING.
  Sampled Brandes above 2,000 nodes, flagged `approximate` (37–46 s exact vs
  0.41 s sampled on a 12k-node graph). Its README Exports-table row sits next to
  the one yogthos/chiasmus#43 changes, so whichever of the two merges second
  needs a one-line rebase; the fork's merge keeps both rows.
- **[upstream] Graph tools in a child process** → `feat/graph-child-process`,
  fork PR [#8](https://github.com/brian-study/chiasmus/pull/8), upstream
  [yogthos/chiasmus#45](https://github.com/yogthos/chiasmus/pull/45) (branch
  `feat/graph-child-process-upstream`: #8's tree as shared web-tree-sitter init
  plus one-file-at-a-time extraction, then one commit for the child process),
  PENDING. It is stacked on
  [yogthos/chiasmus#44](https://github.com/yogthos/chiasmus/pull/44) (branch
  `fix/cache-superseded-entries`, PENDING), which carries two pre-existing cache
  fixes from #8 on their own: a changed file's old entry is deleted, and a file
  listed twice in one call is cached once. `chiasmus_graph`/`chiasmus_map` run in
  one persistent child process (`GraphChildPool`, `graph/child-pool.ts`), which
  SIGKILLs its child from a process `'exit'` listener, so no `process.exit()`
  leaves a graph process running. A design
  change upstream may decline; the first commit stands alone. It replaces the
  worker-thread version (fork PR #5, closed): `worker.terminate()` or
  `process.exit()` while the worker thread was inside native tree-sitter aborted
  the whole server (SIGABRT, `Napi::Error`), and one file's tree walk (90,000
  functions, 6.5 MB) runs for about 15 s with no point where a thread could stop
  cooperatively. A child process is stopped with SIGKILL and can't take the
  server down with it.

Fork-only, on `fork/http-daemon-hardening-v2` (replaces fork PR #7, whose branch
`fork/http-daemon-hardening` sits on the worker-thread design):
- `chiasmus-http` closes a session's MCP server and SkillLibrary when the session
  never starts (the transport rejects the initialize, or connect or the first
  request throws).
- `chiasmus-http` exits 1 on a fatal solver error (`exitOnFatalSolverError()`),
  and its SIGINT/SIGTERM shutdown kills the graph child (`shutdownGraphChild()`).
  The shutdown stops taking connections and requests (503) before it closes the
  sessions and reaps the child, so no session can start while the child is
  reaped and then hold the daemon up with its GET stream.
- A real fatal solver error while the graph child walks a 90,000-function file
  makes both entries exit 1 at once and leaves no graph process
  (`tests/entry-fatal-exit.test.ts`). The kill comes from #8's process `'exit'`
  listener; the test needs both #6 and #8, so it lives here until both are
  upstream.

The fatal-error exit is a plain `process.exit(1)` in both entries, with no exit
coordinator. The worker-thread design needed one (`exitAfterStoppingGraphWorkers`,
on fork PR #7): `process.exit()` under the worker thread inside native tree-sitter
aborted the process, so it stopped a busy worker cooperatively first, with a
grace period and a deadline, and still died of SIGABRT when a single file's walk
outlasted them (a trap during a `chiasmus_map` over that 90,000-function file:
3 of 8 stdio runs, 3 of 3 HTTP runs). In the child-process design no worker
thread in the server runs tree-sitter. `chiasmus_search` still parses inline, as
graph calls do when forced inline (`CHIASMUS_GRAPH_WORKER=off`, or
`registerAdapter()`), but on the main thread, which is also where the fatal exit
runs, so the exit never lands inside a native tree-sitter call: it can't abort,
and there is nothing to wait for. What was left was the busy child, which does
not see its IPC channel close and ran on until its watchdog thread noticed the
parent was gone (up to 500 ms); #8's process `'exit'` listener now kills it.
`exitAfterStoppingGraphWorkers` was not ported.

The fork carries the four branches unchanged, so re-syncing `main` after they
merge upstream can conflict only where fork-only lines change their text:
- `AGENTS.md`: the `mcp-http-server.ts` line in Code Organization, the General
  bullet on `exitOnFatalSolverError`, and the Graph child process bullets "Not a
  worker thread" and "The child never outlives the server".
- `tests/entry-fatal-exit.test.ts`: the helpers (`running`, `startEntry`,
  `stdioCaller`) and the chiasmus-http and graph-job describes.

## Open

> **Filed upstream as [yogthos/chiasmus#36](https://github.com/yogthos/chiasmus/issues/36) (2026-06-08):**
> `serverInfo.version` hardcoded, `converged`=true on unsat, weak Prolog period lint
> (all code-confirmed, zero-doubt), + `chiasmus_learn` promotion + within-domain
> selection precision as lower-confidence "also noticed" mentions. `solve` fill
> non-determinism deliberately NOT filed (inherent LLM limitation, not a defect).
>
> **→ PR [yogthos/chiasmus#37](https://github.com/yogthos/chiasmus/pull/37) MERGED
> (2026-06-08, upstream `576ed38`)** — all three confirmed nits fixed and now in
> our `main` via the rebase. The two "also noticed" items (`chiasmus_learn`
> promotion, within-domain precision) were left out — still open below.

- **`chiasmus_solve` fill non-determinism.** Selector + fill are fixed, but the
  model is still LLM-authored → no hard guarantee (a different, possibly-wrong
  model each run). The lane uses `chiasmus_verify` (agent-authored model) for
  exactly this reason. Either improve fill fidelity (few-shot from the exact
  problem; stronger constraint that every value trace to the problem text) or
  accept `solve` stays advisory-only and document it.

- **Within-domain selection precision.** The embedding re-rank fixed the gross
  cross-domain mis-pick; within the authorization domain, a paraphrase can still
  land `policy-reachability` where `policy-contradiction` is the precise template.
  Lever: also embed the skeleton/tips (currently excluded from the search text),
  or a better embedding model.

- **[upstream, optional] `converged` shape vs docs.** PR #37 documented that
  `converged` ≠ "property holds" (merged). A stronger fix — separating "ran" from
  "holds" in the result *shape* so it can't be misread at all — remains possible if
  the maintainer wants it. Low priority now the docs + lane guard cover it.

- **`chiasmus_learn` is broken — fix or formally retire.** Audit-damning: persists
  wrong generalizations (collapsed a 3-edge graph to 1 → a cycle rule that can
  never fire), Jaccard dedup accumulates near-dupes, enum unvalidated, promotion
  gate dead (learned rows never promoted). Currently SKIP in the lane. Either fix
  the pipeline or disable the tool to stop it polluting the formalize/search space.

## Low value (noted, not planned)

- **`chiasmus_lint`** — the prolog period-check was cosmetic; PR #37 tightened it
  (clause-termination check + corrected message), merged upstream. `lint` stays the
  internal pre-solver auto-fixer; `chiasmus_verify` remains the real syntax oracle.
  Not worth surfacing as a review tool.
