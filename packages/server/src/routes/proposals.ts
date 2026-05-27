import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { PROPOSAL_STATUSES, COMMENT_TYPES } from "@pm/shared";
import type { UserType } from "@pm/shared";
import type { AppVariables } from "../types.js";
import { getDb, users } from "../db/index.js";
import * as proposalService from "../services/proposal.service.js";

// ─── Response schemas ─────────────────────────────────────────────

const proposalSchema = z
  .object({
    id: z.string(),
    projectId: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    createdBy: z.string(),
    resolvedBy: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Proposal");

const commentSchema = z
  .object({
    id: z.string(),
    taskId: z.string().nullable(),
    proposalId: z.string().nullable(),
    authorId: z.string(),
    body: z.string(),
    commentType: z.string(),
    metadata: z.unknown().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Comment");

const epicSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    proposalId: z.string().nullable(),
    milestoneId: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    priority: z.string(),
    targetDate: z.string().nullable(),
    sortOrder: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    createdBy: z.string().nullable(),
  })
  .openapi("ProposalEpic");

const taskSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    proposalId: z.string().nullable(),
    epicId: z.string().nullable(),
    parentTaskId: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    priority: z.string(),
    type: z.string(),
    assigneeId: z.string().nullable(),
    reporterId: z.string(),
    estimatedEffort: z.string().nullable(),
    dueDate: z.string().nullable(),
    sortOrder: z.number(),
    context: z.unknown().nullable(),
    gitBranch: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .openapi("ProposalTask");

const workItemsSchema = z.object({
  epics: z.array(epicSchema),
  tasks: z.array(taskSchema),
});

const proposalDetailSchema = proposalSchema
  .extend({
    comments: z.array(commentSchema),
    workItems: workItemsSchema,
  })
  .openapi("ProposalDetail");

const proposalDataEnvelope = z.object({
  data: proposalSchema,
});

const proposalDetailEnvelope = z.object({
  data: proposalDetailSchema,
});

const proposalListEnvelope = z.object({
  data: z.array(proposalSchema),
  pagination: z.object({
    total: z.number(),
  }),
});

const commentDataEnvelope = z.object({
  data: commentSchema,
});

const commentListEnvelope = z.object({
  data: z.array(commentSchema),
  pagination: z.object({
    total: z.number(),
  }),
});

const workItemsEnvelope = z.object({
  data: workItemsSchema,
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Request schemas ──────────────────────────────────────────────

const createProposalBody = z
  .object({
    title: z.string().min(1, "Title is required"),
    description: z.string().nullable().optional(),
    createdBy: z.string().min(1, "createdBy is required"),
  })
  .openapi("CreateProposal");

const updateProposalBody = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
  })
  .openapi("UpdateProposal");

const transitionBody = z
  .object({
    toStatus: z.enum(PROPOSAL_STATUSES),
    actorId: z.string().min(1, "actorId is required"),
  })
  .openapi("ProposalTransition");

const addCommentBody = z
  .object({
    authorId: z.string().min(1, "authorId is required"),
    body: z.string().min(1, "Comment body is required"),
    commentType: z.enum(COMMENT_TYPES).optional(),
  })
  .openapi("AddProposalComment");

const implementProposalBody = z
  .object({
    actorId: z.string().min(1, "actorId is required"),
    epics: z
      .array(
        z.object({
          name: z.string().min(1),
          description: z.string().nullable().optional(),
          priority: z.string().optional(),
          status: z.string().optional(),
        }),
      )
      .optional()
      .default([]),
    tasks: z
      .array(
        z.object({
          title: z.string().min(1),
          description: z.string().nullable().optional(),
          priority: z.string().optional(),
          type: z.string().optional(),
          epicIndex: z.number().int().min(0).optional(),
        }),
      )
      .optional()
      .default([]),
  })
  .openapi("ImplementProposal");

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const proposalIdParam = z.string().min(1).openapi({
  param: { name: "id", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

// ─── Route definitions ────────────────────────────────────────────

const listProposalsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/proposals",
  tags: ["Proposals"],
  summary: "List proposals",
  description: "List proposals for a project with optional status filter.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: z.object({
      status: z.enum(PROPOSAL_STATUSES).optional(),
    }),
  },
  responses: {
    200: {
      description: "List of proposals",
      content: { "application/json": { schema: proposalListEnvelope } },
    },
  },
});

const createProposalRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/proposals",
  tags: ["Proposals"],
  summary: "Create proposal",
  description: "Create a new proposal for a project.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: {
      content: { "application/json": { schema: createProposalBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Proposal created",
      content: { "application/json": { schema: proposalDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const getProposalRoute = createRoute({
  method: "get",
  path: "/api/v1/proposals/{id}",
  tags: ["Proposals"],
  summary: "Get proposal",
  description: "Get a proposal by ID with comments and linked work items.",
  request: {
    params: z.object({ id: proposalIdParam }),
  },
  responses: {
    200: {
      description: "Proposal details with comments and work items",
      content: { "application/json": { schema: proposalDetailEnvelope } },
    },
    404: {
      description: "Proposal not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const updateProposalRoute = createRoute({
  method: "patch",
  path: "/api/v1/proposals/{id}",
  tags: ["Proposals"],
  summary: "Update proposal",
  description: "Update proposal title or description.",
  request: {
    params: z.object({ id: proposalIdParam }),
    body: {
      content: { "application/json": { schema: updateProposalBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Proposal updated",
      content: { "application/json": { schema: proposalDataEnvelope } },
    },
    404: {
      description: "Proposal not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const transitionProposalRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{id}/transitions",
  tags: ["Proposals"],
  summary: "Transition proposal status",
  description:
    "Change proposal status with role enforcement. Only allowed transitions are permitted.",
  request: {
    params: z.object({ id: proposalIdParam }),
    body: {
      content: { "application/json": { schema: transitionBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Proposal transitioned",
      content: { "application/json": { schema: proposalDataEnvelope } },
    },
    400: {
      description: "Invalid transition",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Forbidden — actor type not allowed for this transition",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Proposal not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const listCommentsRoute = createRoute({
  method: "get",
  path: "/api/v1/proposals/{id}/comments",
  tags: ["Proposals"],
  summary: "List proposal comments",
  description: "List all comments on a proposal.",
  request: {
    params: z.object({ id: proposalIdParam }),
  },
  responses: {
    200: {
      description: "List of comments",
      content: { "application/json": { schema: commentListEnvelope } },
    },
    404: {
      description: "Proposal not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const addCommentRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{id}/comments",
  tags: ["Proposals"],
  summary: "Add comment",
  description:
    "Add a comment to a proposal. If proposal is open and commenter is an AI agent, auto-transitions to discussing.",
  request: {
    params: z.object({ id: proposalIdParam }),
    body: {
      content: { "application/json": { schema: addCommentBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Comment added",
      content: { "application/json": { schema: commentDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Proposal not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const getWorkItemsRoute = createRoute({
  method: "get",
  path: "/api/v1/proposals/{id}/work-items",
  tags: ["Proposals"],
  summary: "List work items",
  description: "List epics and tasks spawned from this proposal.",
  request: {
    params: z.object({ id: proposalIdParam }),
  },
  responses: {
    200: {
      description: "Work items linked to this proposal",
      content: { "application/json": { schema: workItemsEnvelope } },
    },
    404: {
      description: "Proposal not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const implementProposalRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{id}/implement",
  tags: ["Proposals"],
  summary: "Implement proposal",
  description:
    "Atomically create epics and tasks from an accepted proposal, transitioning it to implemented.",
  request: {
    params: z.object({ id: proposalIdParam }),
    body: {
      content: { "application/json": { schema: implementProposalBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Proposal implemented",
      content: { "application/json": { schema: proposalDataEnvelope } },
    },
    400: {
      description: "Invalid status — proposal must be in accepted status",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Proposal not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createProposalRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // GET /api/v1/projects/:projectId/proposals
  router.openapi(listProposalsRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const { status } = c.req.valid("query");
    const proposalsList = proposalService.list(
      projectId,
      status ? { status } : undefined,
    );

    return c.json(
      {
        data: proposalsList,
        pagination: { total: proposalsList.length },
      },
      200,
    );
  });

  // POST /api/v1/projects/:projectId/proposals
  router.openapi(createProposalRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const proposal = proposalService.create(projectId, body);

    return c.json({ data: proposal }, 201);
  });

  // GET /api/v1/proposals/:id
  router.openapi(getProposalRoute, (c) => {
    const { id } = c.req.valid("param");
    const proposal = proposalService.getById(id);

    return c.json({ data: proposal }, 200);
  });

  // PATCH /api/v1/proposals/:id
  router.openapi(updateProposalRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const proposal = proposalService.update(id, body);

    return c.json({ data: proposal }, 200);
  });

  // POST /api/v1/proposals/:id/transitions
  router.openapi(transitionProposalRoute, (c) => {
    const { id } = c.req.valid("param");
    const { toStatus, actorId } = c.req.valid("json");

    // Look up the actor to get their type
    const db = getDb();
    const actor = db
      .select()
      .from(users)
      .where(eq(users.id, actorId))
      .get();

    if (!actor) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `User not found: ${actorId}` } },
        404,
      );
    }

    const proposal = proposalService.transition(id, toStatus, {
      id: actor.id,
      type: actor.type as UserType,
    });

    return c.json({ data: proposal }, 200);
  });

  // GET /api/v1/proposals/:id/comments
  router.openapi(listCommentsRoute, (c) => {
    const { id } = c.req.valid("param");
    const commentsList = proposalService.listComments(id);

    return c.json(
      {
        data: commentsList,
        pagination: { total: commentsList.length },
      },
      200,
    );
  });

  // POST /api/v1/proposals/:id/comments
  router.openapi(addCommentRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const comment = proposalService.addComment(id, body);

    return c.json({ data: comment }, 201);
  });

  // GET /api/v1/proposals/:id/work-items
  router.openapi(getWorkItemsRoute, (c) => {
    const { id } = c.req.valid("param");
    const workItems = proposalService.getWorkItems(id);

    return c.json({ data: workItems }, 200);
  });

  // POST /api/v1/proposals/:id/implement
  router.openapi(implementProposalRoute, (c) => {
    const { id } = c.req.valid("param");
    const { actorId, epics, tasks } = c.req.valid("json");
    const proposal = proposalService.implementProposal(
      id,
      epics,
      tasks,
      actorId,
    );

    return c.json({ data: proposal }, 200);
  });

  return router;
}
