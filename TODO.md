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

The fork now carries ONLY: the HTTP-daemon mode (`src/mcp-http-server.ts`), the
build-on-install prepare script, and this TODO. Re-sync periodically:
`git fetch upstream && git rebase upstream/main` (our 2 commits replay cleanly).

## Open

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

- **[upstream] `converged`/`unsat` ≠ "property holds" — API foot-gun.** A solver
  result of `unsat` / "no solutions" / `converged: true` means only that the
  solver ran and found no counterexample in the *given* model. A consumer reading
  `converged → safe` silently clears bugs (the lane carries a guard for this). The
  result shape should separate "ran" from "holds" so the API can't be misread.

- **`chiasmus_learn` is broken — fix or formally retire.** Audit-damning: persists
  wrong generalizations (collapsed a 3-edge graph to 1 → a cycle rule that can
  never fire), Jaccard dedup accumulates near-dupes, enum unvalidated, promotion
  gate dead (learned rows never promoted). Currently SKIP in the lane. Either fix
  the pipeline or disable the tool to stop it polluting the formalize/search space.

- **[upstream] `serverInfo.version` hardcoded `0.1.0`.** The daemon self-reports
  `0.1.0` regardless of `package.json` — can't trust the running version. Wire it
  to `package.json`.

## Low value (noted, not planned)

- **`chiasmus_lint`** — the prolog period-check is cosmetic (`includes(".")`);
  `chiasmus_verify` is the real syntax oracle. Keep `lint` as the internal
  pre-solver auto-fixer only; not worth surfacing as a review tool.
