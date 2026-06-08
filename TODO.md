# chiasmus — engine TODOs

Backlog for this fork (`brian-study/chiasmus`). Items tagged **[upstream]** are
fork-agnostic improvements worth a PR to `yogthos/chiasmus` (the contributor
guide is `AGENTS.md`; PR style is terse Title Case + `## Problem`/`## Fix`/`## Tests`).

Context: this fork carries the lab harness's chiasmus-verification lane work — see
`harness-plugin/docs/plans/2026-06-08-chiasmus-verification-lane.md`.

## Open

- **[upstream] Upstream the selector + fill fixes — issue #35 OPENED (2026-06-08);
  PR pending maintainer.** `fdf000b` (embedding re-rank for template selection —
  fixes BM25 mis-picking `pagination-sort-stability` for an RBAC problem) and
  `d413cdb` (strict `FORMALIZE_SYSTEM` — stops the slot-fill hallucinating values
  from the template's own examples), improvements over upstream `0.1.21`. Floated
  as yogthos/chiasmus#35 (both problems + our impl, offered to PR — selector is
  the opinionated one since it adds an optional embedding dep to selection). Open
  the PR(s) once the maintainer responds; split into two if they prefer.

- **Track PR #34** (strip internal prolog wrapper variables from solver bindings)
  through review/merge on `yogthos/chiasmus`.

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
