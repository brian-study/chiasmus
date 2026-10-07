# chiasmus — engine TODOs

Backlog for this fork (`brian-study/chiasmus`). Items tagged **[upstream]** are
fork-agnostic improvements worth a PR to `yogthos/chiasmus` (the contributor
guide is `AGENTS.md`; PR style follows #40: a terse conventional-commit title
(`fix(scope): ...`), one commit per logical change, and a `## Problem`/`## Fix`/`## Tests`
body; #40 named the last section `## Verification`).

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

## Pending upstream PRs: server hang hardening (2026-10-07)

The daemon hang hardening (`fix/daemon-hang-hardening`) is split into four
**[upstream]** branches cut from `upstream/main` `55d4388` and worded without fork
references, plus a fork-only remainder. `main` gets them through
`integration/daemon-hardening` (the four merged in the order below) and then
`fork/http-daemon-hardening`. Replace each `#TBD` with the PR number once filed:

- **[upstream] Z3 context leak, PR #TBD, PENDING** → `fix/z3-solve-context-leak`.
  Each solve deletes its own Z3 context; one leaked ~8.7 MB per verify call
  until the fixed 2 GiB WASM heap ran out after ~240 calls and Emscripten aborted.
- **[upstream] Exit after a solver WASM abort, PR #TBD, PENDING** →
  `fix/solver-wasm-abort-exit`, stacked on the context-leak branch. The solvers
  stop calling into a crashed module and the stdio entry exits 1 instead of hanging.
- **[upstream] Bounded `bridges` betweenness, PR #TBD, PENDING** →
  `fix/bounded-bridges-betweenness`. Sampled Brandes above 2,000 nodes, flagged
  `approximate` (37–46 s exact vs 0.41 s sampled on a 12k-node graph). Its
  README Exports-table row sits next to the one the abort-exit branch changes, so
  whichever of the two merges second needs a one-line rebase.
- **[upstream] Graph tools in a worker thread, PR #TBD, PENDING** →
  `feat/graph-worker-thread`. Two commits: shared web-tree-sitter init plus
  one-file-at-a-time extraction, then the worker. A design change upstream may
  decline; the first commit stands alone.

Fork-only, on `fork/http-daemon-hardening`: `chiasmus-http` exits on a fatal
solver error, stops the graph worker on shutdown and closes a session that never
started, and both entries exit through `exitAfterStoppingGraphWorkers`. That last
piece, its own commit (`fix(graph): stop a busy graph worker before a fatal-error
exit`), is an **[upstream]** follow-up once the abort-exit and worker PRs are both
merged, since without it the stdio entry dies of SIGABRT when a solver aborts
during a graph job. It needs a stdio end-to-end case first: a Prolog trap during
a `chiasmus_map` (the stdio transport caps a message at 10 MiB, too small for the
Z3 trap).

The fork carries the four branches unchanged, so re-syncing `main` after they
merge can conflict only where fork-only lines change text from them:
- `AGENTS.md`: the General and Graph worker bullets.
- `src/mcp-server.ts`: the worker-pool import and the `exitOnFatalSolverError` call.
- `src/graph/worker-pool.ts`: the `busy` getter after the constructor, and
  `exitAfterStoppingGraphWorkers` at the end of the file.
- `tests/graph/worker-pool.test.ts`: the import block and the
  `exitAfterStoppingGraphWorkers` describe.
- `tests/entry-fatal-exit.test.ts`: the imports, the header comment, `Z3_TRAP`,
  the `startEntry` signature and the HTTP cases.

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
