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
  "Two changes touched these files: {files}. They produced a merge conflict that " +
  "has been materialized in this worktree — the conflict markers (<<<<<<<, =======, " +
  ">>>>>>>) are in place. Reconcile BOTH intents: edit the conflicted files so the " +
  "combined change preserves what each side was trying to do, and remove every " +
  "conflict marker. Then run the verify command and report the result: {verify_command}";

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
    slo: z
      .object({
        target_p95_time_to_land_sec: z.number().int().min(1).optional(),
        target_verify_success_rate: z.number().min(0).max(1).optional(),
        target_abandon_rate: z.number().min(0).max(1).optional(),
      })
      .optional(),
    // Phase 7.6 — intelligent merge-conflict resolution (§3). Inert until
    // `enabled = true`; absent/empty block ⇒ `{ enabled:false, max_concurrent:1,
    // time_budget_sec:600 }`. Zod 3 applies the inner defaults when the outer
    // `.default({})` fires (the Zod-4 route mirror must use `.prefault({})` to
    // match — see packages/server/src/routes/projects.ts).
    resolver: z
      .object({
        enabled: z.boolean().default(false),
        max_concurrent: z.number().int().min(1).default(1),
        time_budget_sec: z.number().positive().default(600),
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
      ((Boolean(v.verify_command) || v.verify_steps.length > 0) &&
        Boolean(v.worktree_root)),
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

// The three "core" sub-blocks are .optional() because settings are written PARTIALLY
// (each web settings page read-merge-writes a single sub-block) and read TOLERANTLY
// (consumers like autonomy.service fall back to per-field defaults). Requiring them would
// make any project with null/partial stored settings unable to save settings at all.
// Keep in lockstep with the Zod-4 route mirror in packages/server/src/routes/projects.ts.
export const projectSettingsSchema = z
  .object({
    ai_autonomy: aiAutonomySettingsSchema.optional(),
    workflow: workflowSettingsSchema.optional(),
    git: gitSettingsSchema.optional(),
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
