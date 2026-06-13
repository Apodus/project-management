# Campaign C5 — Agent-surface symmetry (MCP read tools)

**Date:** 2026-06-10
**Vision:** `roadmaps/vision-20260610-repo-quality-consolidation.md` §C5 (authoritative — read it)
**Tier:** B (small) · **PM task:** `01KTQS7E74VFEGJNKJ20PY3AM8`
**Goal:** an AI agent can read everything it can write — epic-dependency topology and labels become readable, and liveness fields surface uniformly across all entity renders.
**Branch:** `campaign-c5-agent-symmetry` off post-C1 main, dedicated worktree `D:\code\pm-c5-mcp-symmetry`.

## Scope (verified; full detail in vision §C5 incl. the verifier-killed NOTE_* enum move — do NOT resurrect it)

1. **pm_get_epic_graph(project_id)** — read tool over the existing epic-graph REST endpoint (routes/epic-graph.ts; web roadmap view consumes it). Render: nodes (id, name, status, [Px-y]-style tag if present) + dependency edges + a count header so truncation is never silent. Today pm_get_epic renders NO dependency info — agents link epic deps blind via pm_link_epic_dependency.
2. **pm_list_labels(project_id)** — wraps GET /projects/{projectId}/labels (labels.ts:98); kills blind label_name filtering (tools/tasks.ts:46).
3. **Proposals liveness render:** tools/proposals.ts:50,93 uses claimStatusLabel only; adopt the liveness-aware claimStateLabel like epics/tasks tools. (Type mirrors are fine — claimState? exists on all three summaries; the gap is render-only.)
4. **Description/render polish:** merge-request tool descriptions state explicitly that MRs are integrator-owned, not claimable; one audit pass confirming every tool render includes the entity ids needed for follow-up calls — fix what's missing in this campaign, no standing obligation.

## Coordination

C2 also touches packages/mcp-server/src/api-client.ts (error-body preservation at :791,1532,1632 — small, localized). This campaign ADDS api-client functions (epic-graph, labels). Different regions; rebase-level conflicts unlikely but expected to resolve trivially. Note any contact in the report.

## Tests (gate)

tools.test.ts harness coverage for both new tools + the proposals liveness render; api-client tests for the two new wrappers. Full gate green; one logical commit per phase. No server changes expected (both endpoints exist) — if a server change becomes necessary, return to commander (plan defect).

## Phases (P1–P4 per the approved plan — verifier verdict APPROVE)

Execute the Plan leg's plan as written. Two binding executor notes from the verifier: (a) add BOTH `getEpicGraph` AND `listLabels` to the tools.test.ts `vi.mock` factory (:10-79) — a missing entry fails loudly at module load; (b) guard `cycles ?? []` in the epic-graph render (the service omits the key when the cycle list is empty).

Verifier-confirmed facts: epic-graph node casing is MIXED — snake_case `project_id`/`target_date`/`category`/`created_at`/`activity_recency`/`time_window`, camelCase `taskSummary`/`claimState` (required) — render against these exactly; labels route is unbounded select (total === data.length, dropped pagination harmless); render audit is COMPLETE (independent re-scan found no missed sites; assignee/reporter exclusion is correct — the no-leak sentinel test at tools.test.ts:3190-3221 pins that masking boundary); pm_get_proposal renders linked work items with ids so the implement-proposal hint line works; C5-lands-first shifts C2's cited line numbers — C2's executor re-locates by symbol.
