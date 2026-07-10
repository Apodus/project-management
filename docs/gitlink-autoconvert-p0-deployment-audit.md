# P0 Deployment Audit — cross-repo gitlink-bump auto-convert campaign

**Campaign:** `roadmap-20260710-xrepo-gitlink-bump-autoconvert.md`
**Purpose (Fable P0 gate):** determine what is actually running at game_one before P2 merges,
so the ops handoff leads with the true proximate cause. This does **not** descope the fix —
direction C makes worker behavior permanently irrelevant and needs a daemon redeploy
regardless — but it tells us whether the sanctioned `synthesize_outer` path was ever
*reachable* in production (if the live server predates migration 0027, a worker trying
`synthesize_outer: true` gets a 400 and rationally falls back to minting bump branches).

> **Scope-change trigger (the only one):** if the audit shows workers *did* submit inner-only
> `synthesize_outer` groups and they *failed in production*, halt the campaign and fix that
> defect first. Every other outcome ⇒ proceed with C as planned.

---

## Findings already gathered remotely (from the PM API, this session, 2026-07-10)

- **Train is idle right now** on project `rynx` (game_one): 0 queued, 0 integrating, 0 open
  merge incidents. The ping-pong is intermittent — it bites during contention when a worker
  submits a two-member bump-branch group while another gitlink change lands first — not a
  currently-wedged state.
- **The failure signature is confirmed** from June data: `fix/grass-stability-*` rejected
  repeatedly with `group assembly failed (outer_conflict): rynx`, `conflictingFiles == ["rynx"]`
  (the gitlink pointer only, never outer source). Mechanism verified against the code
  (`group-assembly.ts:161` rebase → conflict on the 160000 `rynx` entry; step 8
  `updateSubmoduleGitlink` overwrites the gitlink regardless, so the bump branch is ceremony).
- **Cannot page to July merge rows from the PM API** (`pm_list_merge_requests` returns the
  oldest 50, no offset param). The post-2026-06-10 categorised history in Probe C below must be
  pulled directly from the DB by the operator.

---

## Probe A — is the sanctioned inner-only path live server-side?

The `synthesize_outer` submit form was added with **migration 0027**, which introduced the
`merge_requests.synthetic` column. Presence of that column ⇒ the endpoint exists on the live
server. Run against the live PM database (default `./data/pm.db`):

```bash
# A1 — is the synthetic column present? (present ⇒ migration 0027+ applied ⇒ endpoint live)
sqlite3 /path/to/live/data/pm.db "PRAGMA table_info(merge_requests);" | grep -i synthetic

# A2 — highest applied migration timestamp (cross-check against the journal watermark)
sqlite3 /path/to/live/data/pm.db "SELECT COUNT(*) AS applied, datetime(MAX(created_at)/1000,'unixepoch') AS newest FROM __drizzle_migrations;"
```

- **A1 returns a `synthetic` row** ⇒ endpoint is live; adoption gap is worker behavior (or bundle
  vintage), not a missing server. → proceed; the broadcast in P4 is the lever.
- **A1 returns nothing** ⇒ the live server predates 0027; `synthesize_outer` 400s; workers had
  **no reachable sanctioned path**. This is the proximate root cause. → still proceed with C
  (worker-agnostic), and the ops handoff leads with "restart/redeploy the PM server."

### Probe A (live-behavior variant — if DB file is not hand-accessible)

From any MCP-connected agent, attempt an inner-only submit against a throwaway task and observe
the response tier (a `VALIDATION_ERROR` naming `synthesize_outer` ⇒ endpoint present but input
rejected; an `UNKNOWN_ERROR`/route-Zod 400 that doesn't recognise the field ⇒ endpoint absent).
Do **not** leave a real group queued — cancel immediately (`pm_cancel_merge_request`).

---

## Probe B — integrator daemon vintage + start time

The auto-convert code (P2) only takes effect once the daemon bundle carrying it is deployed and
the daemon restarted. Establish the current baseline:

```bash
# B1 — deployed bundle version + the commit it was built from (game_one target machine)
cat /path/to/pm-integrator-bundle/package.json | grep '"version"'
cat /path/to/pm-integrator-bundle/BUILD_INFO 2>/dev/null   # if the distribute bundle stamps one

# B2 — daemon process start time (is it long-running, and since when?)
#   Windows:
powershell "Get-Process -Name node | Select-Object Id,StartTime,Path"
#   or inspect the newest daemon log header for its boot line + config dump
```

Record: bundle version, built-from commit (compare to `main` — does it even contain the
2026-06-10 inner-only work `fbd7e5c`?), and whether the daemon was restarted after the last
`settings.integrator.resolver`/config change.

---

## Probe C — post-2026-06-10 merge history, by category

Determine whether the ping-pong is still occurring in July, and whether any inner-only groups
have been used (adoption signal). Run against the live DB:

```bash
# C1 — merge requests since the inner-only ship date, newest first, with member shape
sqlite3 -header -column /path/to/live/data/pm.db "
  SELECT substr(id,1,10) AS id, status, synthetic, group_id IS NOT NULL AS grouped,
         datetime(created_at/1000,'unixepoch') AS enqueued, branch
  FROM merge_requests
  WHERE created_at >= strftime('%s','2026-06-10')*1000
  ORDER BY created_at DESC LIMIT 100;"

# C2 — rejection categories in that window (the attempt-level failure_category)
sqlite3 -header -column /path/to/live/data/pm.db "
  SELECT a.failure_category, COUNT(*) AS n
  FROM merge_attempts a JOIN merge_requests r ON a.merge_request_id = r.id
  WHERE r.created_at >= strftime('%s','2026-06-10')*1000
  GROUP BY a.failure_category ORDER BY n DESC;"

# C3 — any inner-only / synthetic members ever? (adoption proof)
sqlite3 /path/to/live/data/pm.db "SELECT COUNT(*) FROM merge_requests WHERE synthetic = 1;"
```

> Column names (`group_id`, `merge_attempts`, `failure_category`) reflect the schema in this
> repo; if the live DB predates a rename, adapt. `merge_requests.synthetic` and
> `merge_attempts.failure_category` are the load-bearing ones.

### Interpretation matrix

| C3 synthetic count | July `outer_conflict` rejections (C2) | Reading | Action |
|---|---|---|---|
| 0 | present | Sanctioned path never adopted; ping-pong ongoing | Proceed with C; broadcast + redeploy. If A1 empty, that's *why* (unreachable). |
| >0 | present | Some adoption, but bump-branch groups still submitted | Proceed with C; C covers the non-compliant remainder. |
| >0 | absent (all landed / verify-only) | Adoption succeeded; no live gitlink ping-pong now | C is still correct hardening but priority drops; confirm with director before investing further. |
| any | inner-only groups **failing** in prod | **Scope-change trigger** | Halt; fix the inner-only defect first (see roadmap). |

---

## Deliverable

Operator runs Probes A–C on the game_one machine and records the results below (or pastes them
back to the commander). The campaign proceeds through P1–P3 in parallel with this — only the
**P4 ops handoff messaging** and the go/no-go on the scope-change trigger depend on the outcome.

### Results (fill in)

- **A1 synthetic column present?** ⬜ yes ⬜ no →
- **A2 applied migrations / newest:** →
- **B1 bundle version / built-from commit:** →
- **B2 daemon start time / restarted since last config change?** →
- **C1/C2 July categories:** →
- **C3 synthetic count (ever):** →
- **Scope-change trigger hit?** ⬜ no → proceed ⬜ yes → halt + fix inner-only defect
