# chiasmus — engine TODOs

Backlog for this fork (`brian-study/chiasmus`). Items tagged **[upstream]** are
fork-agnostic improvements worth a PR to `yogthos/chiasmus` (the contributor
guide is `AGENTS.md`; PR style is terse Title Case + `## Problem`/`## Fix`/`## Tests`).

Context: this fork carries the lab harness's chiasmus-verification lane work — see
`harness-plugin/docs/plans/2026-06-08-chiasmus-verification-lane.md`.

## Synced to upstream 0.1.24 (2026-06-08)

The fork was rebased onto `yogthos/chiasmus` 0.1.24. Three of our fixes are now
upstream and our local versions were dropped as superseded:
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

The fork now carries ONLY: the HTTP-daemon mode (`src/mcp-http-server.ts`), the
build-on-install prepare script, and this TODO. Last rebased onto `576ed38`
(post-#37). Re-sync periodically: `git fetch upstream && git rebase upstream/main`
(our commits replay cleanly).

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
