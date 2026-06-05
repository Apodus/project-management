import { z } from "zod";
import { PROJECT_STATUSES, TASK_STATUSES, CACHE_MODES } from "../constants/enums.js";
import { ulidSchema, timestampSchema, optionalText } from "./common.js";

/**
 * Phase 7.6 — the default reconcile instruction handed to the headless conflict
 * resolver. `settings.integrator.resolver.prompt` overrides it. The `{files}` and
 * `{verify_command}` placeholders are substituted at run time by the integrator's
 * resolver runner; a custom prompt may use them too (or omit them). Single source
 * of truth shared by the integrator (the runner) and the web UI (shown via the
 * resolver-defaults endpoint, since the web package cannot import @pm/shared).
 */
export const DEFAULT_RESOLVER_PROMPT =
  "You are the COMMANDER of a merge-conflict resolution. Two changes both modified these files " +
  "and produced a merge conflict that has been materialized in this worktree — the conflict " +
  "markers (<<<<<<<, =======, >>>>>>>) are in place in: {files}.\n\n" +
  "Your job is high-level judgment and orchestration — NOT hands-on work. Delegate every step to a " +
  "FRESH generic general-purpose sub-agent running the same model you are (never an Explore or any " +
  "other specialized agent). Spawn a NEW sub-agent for each step so each starts with clean context, " +
  "and pass it the previous steps' findings:\n" +
  "1. INVESTIGATE — a sub-agent works out, for each conflict region, what each side was actually " +
  "trying to accomplish (from the conflicted files and the surrounding code). Facts, not fixes.\n" +
  "2. PLAN — a sub-agent proposes the resolution (see 'How to reconcile' below).\n" +
  "3. VERIFY THE PLAN — a DIFFERENT sub-agent (never the one that planned) adversarially checks the " +
  "plan for correctness, completeness, and whether it will compile and pass verify. A planner " +
  "checking its own work is worthless; this MUST be an independent agent.\n" +
  "4. EXECUTE — a sub-agent applies the approved plan: edit the conflicted files so the combined " +
  "result is correct, make any supporting edits correctness needs, and remove every conflict " +
  "marker.\n\n" +
  "5. VERIFY (you own it) — you yourself run the project's verify command `{verify_command}` (and/or " +
  "its individual steps) and iterate the loop: resolve → verify → read the failure → fix (delegate " +
  "each fix to a FRESH sub-agent, same as every other step) → re-verify. Targeted or partial checks " +
  "are fine for fast iteration while you converge, but you MUST see the FULL `{verify_command}` suite " +
  "pass green before you may declare complete. Do NOT declare done on a partial or targeted check — " +
  "only a clean full-suite run counts.\n" +
  "6. DECLARE (mandatory final action) — as your FINAL action, write your outcome as JSON to the file " +
  "path given in the PM_RESOLUTION_STATUS_PATH environment variable. That path is OUTSIDE this " +
  "worktree — write it there and do NOT create it inside the tree. Write exactly " +
  '`{"status":"complete"}` once the full `{verify_command}` suite is green, or ' +
  '`{"status":"give_up","reason":"…"}` if after genuine effort no clear path to a green full suite ' +
  "exists. Writing this file is MANDATORY: if it is absent the resolution is treated as incomplete " +
  "and escalated. Do not thrash — if you cannot get there, give up honestly rather than loop " +
  "forever.\n\n" +
  "You hold final judgment. Weigh the verify agent's findings and decide; you MAY override it when " +
  "you judge it wrong, and you may re-run any step with a fresh agent. Getting the resolution RIGHT " +
  "matters more than finishing fast — spend the effort. You are fully authorized: do not ask anyone " +
  "for permission or confirmation.\n\n" +
  "How to reconcile — first diagnose the KIND of conflict:\n" +
  "- COMPLEMENTARY (the two sides address different concerns): combine them so the result preserves " +
  "BOTH intents.\n" +
  "- COMPETING (both sides solve the SAME problem in different ways): do NOT force both into the " +
  "merge. Pick the single better solution; if they are essentially equivalent, cleanly pick one. One " +
  "coherent solution always beats a Frankenstein of two.\n\n" +
  "After you finish, the integrator independently re-runs `{verify_command}` as the final landing " +
  "gate — but that is a BACKSTOP, not a substitute for getting the full suite green in-session. A " +
  "resolution that has not passed the full suite under your own VERIFY step wastes that gate and gets " +
  "escalated; getting the full suite green yourself is the whole job. Leave your resolved files in " +
  "the working tree — do not commit, push, or create branches; the integrator handles that.";

export const aiAutonomySettingsSchema = z.object({
  can_self_assign: z.boolean(),
  can_create_subtasks: z.boolean(),
  can_create_tasks: z.boolean(),
  can_change_priority: z.boolean(),
  can_close_epics: z.boolean(),
  max_concurrent_tasks: z.number().int().min(1),
});

export const workflowSettingsSchema = z.object({
  statuses: z.array(z.enum(TASK_STATUSES)),
});

export const gitSettingsSchema = z.object({
  branch_prefix: z.string(),
  auto_link_branches: z.boolean(),
});

export const linkedRepoSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  role: z.enum(["inner", "outer"]),
  gitlink_parent: z.string().min(1).optional(),
  gitlink_path: z.string().min(1).optional(),
});

// Phase 7.5 — a single verify-step in the verify_steps DAG (design §2.1/§8.1).
// id: unique within the array. command: the shell command. depends_on: predecessor
// step ids (DAG edges). cache_key_inputs: out-of-tree fingerprint values folded into
// step_config_sha (§3.3). timeout_sec: per-step override of verify_timeout_sec.
export const verifyStepSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  depends_on: z.array(z.string().min(1)).default([]),
  cache_key_inputs: z.array(z.string().min(1)).default([]),
  timeout_sec: z.number().int().min(1).optional(),
});
export type VerifyStep = z.infer<typeof verifyStepSchema>;

// PURE config-time DAG validator (design §2.1). Returns the issues a .superRefine
// raises as 400s: duplicate id, a depends_on referencing a non-existent id (dangling),
// and a cycle (detected via Kahn's topo sort — a self-loop a->a is a 1-cycle Kahn's
// catches). Duplicated verbatim (not imported) by the Zod-4 route mirror in
// packages/server/src/routes/projects.ts — keep the two in lockstep.
function hasDagIssues(steps: { id: string; depends_on?: string[] }[]): {
  dup?: string;
  dangling?: string;
  cycle?: boolean;
} {
  const ids = new Set<string>();
  let dup: string | undefined;
  for (const s of steps) {
    if (ids.has(s.id)) {
      dup = dup ?? s.id;
    }
    ids.add(s.id);
  }

  let dangling: string | undefined;
  for (const s of steps) {
    for (const dep of s.depends_on ?? []) {
      if (!ids.has(dep)) {
        dangling = dangling ?? dep;
      }
    }
  }

  // Kahn's algorithm: in-degree map → queue 0-indegree → consume; if fewer than
  // steps.length nodes are consumed a cycle exists (a self-loop a->a gives a->a an
  // in-degree of 1 that never reaches 0). Operates over the (de-duplicated) id set
  // so dup/dangling don't mask a cycle.
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of ids) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }
  for (const s of steps) {
    for (const dep of s.depends_on ?? []) {
      // edge dep -> s.id; only count edges within the known id set.
      if (ids.has(dep) && ids.has(s.id)) {
        adj.get(dep)!.push(s.id);
        inDegree.set(s.id, (inDegree.get(s.id) ?? 0) + 1);
      }
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  let consumed = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    consumed++;
    for (const next of adj.get(node) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  const cycle = consumed < ids.size;

  return { dup, dangling, cycle };
}

export const integratorSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    verify_command: z.string().min(1).optional(),
    verify_timeout_sec: z.number().int().min(1).default(600),
    worktree_root: z.string().min(1).optional(),
    git_remote: z.string().min(1).default("origin"),
    git_main_branch: z.string().min(1).default("main"),
    worktree_name: z.string().min(1).optional(),
    parallelism: z.number().int().min(1).default(1),
    linked_repos: z.array(linkedRepoSchema).default([]),
    heartbeat_interval_sec: z.number().int().min(5).default(30),
    cache_enabled: z.boolean().default(false),
    cache_mode: z.enum(CACHE_MODES).default("off"),
    verify_steps: z.array(verifyStepSchema).default([]),
    clean_keep: z.array(z.string().min(1)).default([]),
    slo: z
      .object({
        target_p95_time_to_land_sec: z.number().int().min(1).optional(),
        target_verify_success_rate: z.number().min(0).max(1).optional(),
        target_abandon_rate: z.number().min(0).max(1).optional(),
      })
      .optional(),
    // Phase 7.6 — intelligent merge-conflict resolution (§3). Inert until
    // `enabled = true`; absent/empty block ⇒ `{ enabled:false, max_concurrent:1,
    // time_budget_sec:3600 }`. Zod 3 applies the inner defaults when the outer
    // `.default({})` fires (the Zod-4 route mirror must use `.prefault({})` to
    // match — see packages/server/src/routes/projects.ts). Phase 7.6.1:
    // time_budget_sec now bounds the WHOLE in-session resolve→verify loop the
    // agent owns (not a single attempt), hence the larger default.
    resolver: z
      .object({
        enabled: z.boolean().default(false),
        max_concurrent: z.number().int().min(1).default(1),
        time_budget_sec: z.number().positive().default(3600),
        token_budget: z.number().positive().optional(),
        command: z.string().min(1).optional(),
        // Override for the reconcile instruction the headless resolver receives.
        // Absent ⇒ DEFAULT_RESOLVER_PROMPT. The `{files}` and `{verify_command}`
        // placeholders are substituted at run time (Phase 7.6 §5.2).
        prompt: z.string().min(1).optional(),
      })
      .default({}),
  })
  // Phase 7.5 — DAG validation (§2.1): duplicate id / dangling depends_on / cycle
  // are all 400s. An empty verify_steps array yields no issues (backward-compat inert).
  .superRefine((v, ctx) => {
    const { dup, dangling, cycle } = hasDagIssues(v.verify_steps);
    if (dup) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate verify_steps id: "${dup}".`,
        path: ["verify_steps"],
      });
    }
    if (dangling) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `verify_steps depends_on references a non-existent step id: "${dangling}".`,
        path: ["verify_steps"],
      });
    }
    if (cycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verify_steps contains a dependency cycle.",
        path: ["verify_steps"],
      });
    }
  })
  .refine(
    (v) =>
      !v.enabled ||
      ((Boolean(v.verify_command) || v.verify_steps.length > 0) && Boolean(v.worktree_root)),
    {
      message:
        "When integrator.enabled is true, verify_command (or a non-empty verify_steps) and worktree_root are required and must be non-empty.",
      path: ["enabled"],
    },
  );

// Per-project outbound alert webhook config (Phase 7.4 §7.2). A Discord
// webhook URL the three train.* alerts are POSTed to (half (b) of dual
// delivery). alerts_enabled defaults to "on" — set false to silence the
// outbound POST without removing the URL.
export const webhooksSettingsSchema = z.object({
  discord_url: z.string().url().optional(),
  alerts_enabled: z.boolean().optional(),
});

// Per-project epic category — a named, colored bucket epics can be tagged with
// (P1: data + contract only; web UI / DAG coloring land in later phases). An
// epic's `category` field holds the `name` of one of these; an unknown value
// renders uncategorized (no FK enforcement — the set is free-form project config).
export const epicCategorySchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
  sort_order: z.number().int(),
});

// The three "core" sub-blocks are `.partial().optional()` because settings are written
// PARTIALLY (each web settings page read-merge-writes a single sub-block) and read
// TOLERANTLY (consumers like autonomy.service fall back to per-field defaults). The block
// may be absent, and when present (preserved from a project with partial stored settings)
// its individual fields may be missing too. Requiring the full block — or all its fields —
// would make any project with null/partial stored settings unable to save settings at all.
// Keep in lockstep with the Zod-4 route mirror in packages/server/src/routes/projects.ts.
export const projectSettingsSchema = z
  .object({
    ai_autonomy: aiAutonomySettingsSchema.partial().optional(),
    workflow: workflowSettingsSchema.partial().optional(),
    git: gitSettingsSchema.partial().optional(),
    integrator: integratorSettingsSchema.optional(),
    webhooks: webhooksSettingsSchema.optional(),
    epic_categories: z.array(epicCategorySchema).optional(),
  })
  .nullable()
  .optional();

export const selectProjectSchema = z.object({
  id: ulidSchema,
  workspace_id: ulidSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  description: optionalText,
  status: z.enum(PROJECT_STATUSES),
  git_repo_url: optionalText,
  settings: projectSettingsSchema,
  sort_order: z.number().int(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  created_by: ulidSchema,
});

export const insertProjectSchema = selectProjectSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});
