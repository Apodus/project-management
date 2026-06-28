import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  PROJECT_STATUSES,
  TASK_STATUSES,
  CACHE_MODES,
  AUTO_IMPLEMENT_MODES,
  NOTES_TRIAGE_MODES,
  cacheConfigWarnings,
} from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as projectService from "../services/project.service.js";

// ─── Settings schemas (Zod 4 mirror of @pm/shared/projectSettingsSchema) ──
// @pm/shared uses Zod 3, but @hono/zod-openapi requires Zod 4 schemas, so
// the route body validation uses Zod 4 schemas here. Shape MUST match
// @pm/shared/projectSettingsSchema. See packages/shared/src/schemas/project.ts.

const aiAutonomySettingsSchema = z.object({
  can_self_assign: z.boolean(),
  can_create_subtasks: z.boolean(),
  can_create_tasks: z.boolean(),
  can_change_priority: z.boolean(),
  can_close_epics: z.boolean(),
  max_concurrent_tasks: z.number().int().min(1),
});

const workflowSettingsSchema = z.object({
  statuses: z.array(z.enum(TASK_STATUSES)),
});

const gitSettingsSchema = z.object({
  branch_prefix: z.string(),
  auto_link_branches: z.boolean(),
});

const linkedRepoSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  role: z.enum(["inner", "outer"]),
  gitlink_parent: z.string().min(1).optional(),
  gitlink_path: z.string().min(1).optional(),
});

// Phase 7.5 — Zod-4 mirror of @pm/shared/verifyStepSchema (§2.1/§8.1).
const verifyStepSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  depends_on: z.array(z.string().min(1)).default([]),
  cache_key_inputs: z.array(z.string().min(1)).default([]),
  timeout_sec: z.number().int().min(1).optional(),
});

// PURE config-time DAG validator — a verbatim DUPLICATE of the Zod-3 helper in
// packages/shared/src/schemas/project.ts (NOT imported: this is the load-bearing
// route-mirror so the PATCH 400-gate catches a cycle/dangling/dup before a cyclic
// DAG hangs the integrator pipeline). Keep the two copies in lockstep. (§2.1)
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

  // Kahn's topo sort: if fewer nodes are consumed than exist, a cycle exists
  // (a self-loop a->a leaves a's in-degree permanently at 1).
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of ids) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }
  for (const s of steps) {
    for (const dep of s.depends_on ?? []) {
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

const integratorSettingsSchema = z
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
    // Phase 7.6 — intelligent merge-conflict resolution (§3). Sibling of `slo`.
    // NOTE: diverges from the Zod-3 canonical (`@pm/shared`) `.default({})` on
    // purpose. Zod 3 and Zod 4 differ on a nested `.default({})` for the
    // absent-key path: Zod 3 applies the inner field defaults, but Zod 4 (4.4.3,
    // used by @hono/zod-openapi) yields a literal `{}` with inner defaults NOT
    // applied. The contract is identical OUTPUT shape, so we use `.prefault({})`
    // here — prefault feeds `{}` as INPUT, so the inner defaults DO run, yielding
    // the same inert `{ enabled:false, max_concurrent:1, time_budget_sec:3600 }`.
    resolver: z
      .object({
        enabled: z.boolean().default(false),
        max_concurrent: z.number().int().min(1).default(1),
        time_budget_sec: z.number().positive().default(3600),
        token_budget: z.number().positive().optional(),
        command: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
      })
      .prefault({}),
  })
  // Phase 7.5 — DAG validation (§2.1): dup id / dangling depends_on / cycle -> 400.
  // Empty verify_steps = no issues (backward-compat inert).
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

// Zod-4 mirror of @pm/shared/webhooksSettingsSchema (§7.2). MUST stay
// identical to the canonical shape or PATCH silently strips discord_url.
const webhooksSettingsSchema = z.object({
  discord_url: z.string().url().optional(),
  alerts_enabled: z.boolean().optional(),
});

// Zod-4 mirror of @pm/shared/autoImplementSettingsSchema — keep in lockstep.
// MUST stay identical to the canonical shape (incl. mode default "shadow") or
// PATCH silently strips autoImplement / an openapi drift surfaces. Leaf scalars
// carry `.default(...)` so plain `.optional()` on both sides — the `.prefault({})`
// divergence applies only to the nested resolver `.default({})` block, NOT here.
const autoImplementSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(AUTO_IMPLEMENT_MODES).default("shadow"),
});

// Zod-4 mirror of @pm/shared/notesTriageSettingsSchema — keep in lockstep.
const notesTriageSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(NOTES_TRIAGE_MODES).default("shadow"),
  triageAgentId: z.string().min(1).optional(),
});

// Zod-4 mirror of @pm/shared/epicCategorySchema. MUST stay identical to the
// canonical shape or PATCH silently strips epic_categories.
const epicCategorySchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
  sort_order: z.number().int(),
});

// Settings writes are PARTIAL by nature (the web settings pages each read-merge-write
// a single sub-block) and every sub-block is read tolerantly with per-field defaults
// (autonomy.service, etc.) — so the three "core" blocks are `.partial().optional()` here:
// the block may be absent, AND when present (preserved from a project whose stored
// settings are partial) its individual fields may be missing too. Requiring the full
// block — or all its fields — would make ANY project whose stored settings are
// null/partial (created via the API or MCP without a full seed) unable to save ANY
// settings page. Keep in lockstep with the canonical @pm/shared/projectSettingsSchema.
const projectSettingsSchema = z
  .object({
    ai_autonomy: aiAutonomySettingsSchema.partial().optional(),
    workflow: workflowSettingsSchema.partial().optional(),
    git: gitSettingsSchema.partial().optional(),
    integrator: integratorSettingsSchema.optional(),
    webhooks: webhooksSettingsSchema.optional(),
    autoImplement: autoImplementSettingsSchema.optional(),
    notesTriage: notesTriageSettingsSchema.optional(),
    epic_categories: z.array(epicCategorySchema).optional(),
  })
  .nullable()
  .optional();

// ─── Response schemas ─────────────────────────────────────────────

const projectSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    gitRepoUrl: z.string().nullable(),
    settings: z.unknown().nullable(),
    sortOrder: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    createdBy: z.string().nullable(),
  })
  .openapi("Project");

const projectDataEnvelope = z.object({
  data: projectSchema,
});

// C2: the PATCH 200 envelope can carry advisory config warnings (the
// verify-cache guardrail — see cacheConfigWarnings). `warnings` is OMITTED
// when empty, never `[]`, so unchanged responses stay byte-identical.
const projectUpdateEnvelope = z.object({
  data: projectSchema,
  warnings: z.array(z.string()).optional(),
});

const projectListEnvelope = z.object({
  data: z.array(projectSchema),
  pagination: z.object({
    total: z.number(),
  }),
});

const projectStatsSchema = z
  .object({
    tasksByStatus: z.record(z.string(), z.number()),
    totalTasks: z.number(),
    epicCount: z.number(),
    proposalCount: z.number(),
  })
  .openapi("ProjectStats");

const projectStatsEnvelope = z.object({
  data: projectStatsSchema,
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ──────────────────────────────────────────────

const createProjectBody = z
  .object({
    name: z.string().min(1, "Name is required"),
    description: z.string().nullable().optional(),
    gitRepoUrl: z.string().nullable().optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    settings: projectSettingsSchema,
    sortOrder: z.number().int().optional(),
  })
  .openapi("CreateProject");

const updateProjectBody = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    gitRepoUrl: z.string().nullable().optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    settings: projectSettingsSchema,
    sortOrder: z.number().int().optional(),
  })
  .openapi("UpdateProject");

const projectIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "id", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

// ─── Route definitions ────────────────────────────────────────────

const listProjectsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects",
  tags: ["Projects"],
  summary: "List projects",
  description: "List all projects with optional status filter.",
  request: {
    query: z.object({
      status: z.enum(PROJECT_STATUSES).optional(),
    }),
  },
  responses: {
    200: {
      description: "List of projects",
      content: { "application/json": { schema: projectListEnvelope } },
    },
  },
});

const createProjectRoute = createRoute({
  method: "post",
  path: "/api/v1/projects",
  tags: ["Projects"],
  summary: "Create project",
  description: "Create a new project. A slug is auto-generated from the name.",
  request: {
    body: {
      content: { "application/json": { schema: createProjectBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Project created",
      content: { "application/json": { schema: projectDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const getProjectRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{id}",
  tags: ["Projects"],
  summary: "Get project",
  description: "Get a project by ID.",
  request: {
    params: z.object({ id: projectIdParam }),
  },
  responses: {
    200: {
      description: "Project details",
      content: { "application/json": { schema: projectDataEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const updateProjectRoute = createRoute({
  method: "patch",
  path: "/api/v1/projects/{id}",
  tags: ["Projects"],
  summary: "Update project",
  description:
    'Update project fields. The 200 envelope may carry advisory `warnings` (omitted when empty) — e.g. the verify-cache guardrail: cache_mode "on" with verify steps lacking cache_key_inputs is the documented false-pass precondition (deployment guide §16.2; shadow-first discipline). Warnings never block the save.',
  request: {
    params: z.object({ id: projectIdParam }),
    body: {
      content: { "application/json": { schema: updateProjectBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Project updated (with optional advisory warnings)",
      content: { "application/json": { schema: projectUpdateEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const deleteProjectRoute = createRoute({
  method: "delete",
  path: "/api/v1/projects/{id}",
  tags: ["Projects"],
  summary: "Archive project",
  description: "Soft-delete a project by setting its status to archived.",
  request: {
    params: z.object({ id: projectIdParam }),
  },
  responses: {
    200: {
      description: "Project archived",
      content: { "application/json": { schema: projectDataEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const getProjectStatsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{id}/stats",
  tags: ["Projects"],
  summary: "Project statistics",
  description: "Get task counts by status, epic count, and proposal count for a project.",
  request: {
    params: z.object({ id: projectIdParam }),
  },
  responses: {
    200: {
      description: "Project statistics",
      content: { "application/json": { schema: projectStatsEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createProjectRoutes(): OpenAPIHono<{ Variables: AppVariables }> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects
  router.openapi(listProjectsRoute, (c) => {
    const { status } = c.req.valid("query");
    const projectsList = projectService.list(status ? { status } : undefined);

    return c.json(
      {
        data: projectsList,
        pagination: { total: projectsList.length },
      },
      200,
    );
  });

  // POST /api/v1/projects
  router.openapi(createProjectRoute, (c) => {
    const body = c.req.valid("json");
    const project = projectService.create(body);

    return c.json({ data: project }, 201);
  });

  // GET /api/v1/projects/:id
  router.openapi(getProjectRoute, (c) => {
    const { id } = c.req.valid("param");
    const project = projectService.getById(id);

    return c.json({ data: project }, 200);
  });

  // PATCH /api/v1/projects/:id
  router.openapi(updateProjectRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const project = projectService.update(id, body);

    // C2 guardrail: compute advisory warnings from the PERSISTED settings
    // post-update (not the request body — a partial PATCH that leaves a
    // dangerous stored config in place still warns). Omit when empty.
    const settings = (project.settings ?? {}) as {
      integrator?: Parameters<typeof cacheConfigWarnings>[0];
    };
    const warnings = cacheConfigWarnings(settings.integrator);

    return c.json(warnings.length > 0 ? { data: project, warnings } : { data: project }, 200);
  });

  // DELETE /api/v1/projects/:id
  router.openapi(deleteProjectRoute, (c) => {
    const { id } = c.req.valid("param");
    const project = projectService.archive(id);

    return c.json({ data: project }, 200);
  });

  // GET /api/v1/projects/:id/stats
  router.openapi(getProjectStatsRoute, (c) => {
    const { id } = c.req.valid("param");
    const stats = projectService.getStats(id);

    return c.json({ data: stats }, 200);
  });

  return router;
}
