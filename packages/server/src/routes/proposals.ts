import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  CLAIM_RESULT_STATUSES,
  CLAIM_STATUSES,
  CLAIM_STATES,
  PROPOSAL_STATUSES,
  COMMENT_TYPES,
} from "@pm/shared";
import type { UserType } from "@pm/shared";
import type { AppVariables } from "../types.js";
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
    claimedBy: z.string().nullable(),
    claimStatus: z.enum(CLAIM_STATUSES),
    claimState: z.enum(CLAIM_STATES),
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

const claimResultSchema = z
  .object({
    ok: z.boolean(),
    status: z.enum(CLAIM_RESULT_STATUSES),
  })
  .openapi("ClaimResult");

const claimResultEnvelope = z.object({ data: claimResultSchema });

const forceClaimBody = z
  .object({
    reason: z.string().min(1).max(2048),
    newAssigneeId: z.string().optional(),
  })
  .openapi("ForceClaimProposal");

const forceClaimResultEnvelope = z.object({
  data: z.object({
    ok: z.boolean(),
    status: z.literal("force_claimed"),
    previousHolder: z.string(),
    newHolder: z.string(),
  }),
});

// Handoff bodies (Campaign C3 §P5b).
const releaseToBody = z
  .object({
    reason: z.string().min(1).max(2048),
    targetId: z.string().min(1),
  })
  .openapi("ReleaseProposal");

const requestTakeoverBody = z
  .object({
    reason: z.string().min(1).max(2048),
  })
  .openapi("RequestTakeoverProposal");

const requestTakeoverResultEnvelope = z.object({
  data: z.object({
    ok: z.boolean(),
    status: z.enum(CLAIM_RESULT_STATUSES),
    previousHolder: z.string().optional(),
    newHolder: z.string().optional(),
  }),
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
    createdBy: z.string().min(1).optional(),
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
  })
  .openapi("ProposalTransition");

const addCommentBody = z
  .object({
    body: z.string().min(1, "Comment body is required"),
    commentType: z.enum(COMMENT_TYPES).optional(),
  })
  .openapi("AddProposalComment");

const implementProposalBody = z
  .object({
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

const projectIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "projectId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const proposalIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "id", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const claimFilterQuery = z.enum(["available", "mine", "all"]).optional();

// ─── Route definitions ────────────────────────────────────────────

const listProposalsRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/proposals",
  tags: ["Proposals"],
  summary: "List proposals",
  description: "List proposals for a project with optional status and claim filters.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: z.object({
      status: z.enum(PROPOSAL_STATUSES).optional(),
      claim: claimFilterQuery,
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
    "Change proposal status with role enforcement. AI agents must hold the claim. Terminal transitions clear the claim.",
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
    409: {
      description: "Claim denied — proposal claimed by another agent or unclaimed",
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
    "Add a comment to a proposal. AI agents must hold the claim. If proposal is open and commenter is an AI agent, auto-transitions to discussing.",
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
    409: {
      description: "Claim denied — proposal claimed by another agent or unclaimed",
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
    "Atomically create epics and tasks from a proposal, transitioning it to in_progress. AI agents must hold the claim.",
  request: {
    params: z.object({ id: proposalIdParam }),
    body: {
      content: { "application/json": { schema: implementProposalBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Proposal moved to in_progress and work items created",
      content: { "application/json": { schema: proposalDataEnvelope } },
    },
    400: {
      description: "Invalid status — proposal is already in_progress, completed, or rejected",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Proposal not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Claim denied — proposal claimed by another agent or unclaimed",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const claimProposalRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{id}/claim",
  tags: ["Proposals"],
  summary: "Claim proposal",
  description:
    "Atomically claim a proposal for the caller. Returns a structured result without leaking other claimants' IDs.",
  request: {
    params: z.object({ id: proposalIdParam }),
  },
  responses: {
    200: {
      description: "Claim attempt outcome",
      content: { "application/json": { schema: claimResultEnvelope } },
    },
    404: {
      description: "Proposal not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const forceClaimProposalRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{id}/force-claim",
  tags: ["Proposals"],
  summary: "Force-claim proposal (takeover)",
  description:
    "Take over an existing claim (reason required, audited). Self-recovery when a session identity changed. Targeting another agent requires a human director.",
  request: {
    params: z.object({ id: proposalIdParam }),
    body: {
      content: { "application/json": { schema: forceClaimBody } },
    },
  },
  responses: {
    200: {
      description: "Force-claim outcome",
      content: { "application/json": { schema: forceClaimResultEnvelope } },
    },
    400: {
      description: "Validation error (empty reason)",
      content: { "application/json": { schema: errorEnvelope } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Forbidden (non-human targeting another agent)",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Proposal or target user not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Proposal closed / not associated with a project",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const releaseProposalRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{id}/release",
  tags: ["Proposals"],
  summary: "Release proposal claim",
  description:
    "Release the caller's claim on a proposal. Humans can release any claim; AI agents only their own.",
  request: {
    params: z.object({ id: proposalIdParam }),
  },
  responses: {
    200: {
      description: "Release attempt outcome",
      content: { "application/json": { schema: claimResultEnvelope } },
    },
    404: {
      description: "Proposal not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const releaseToProposalRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{id}/release-to",
  tags: ["Proposals"],
  summary: "Release proposal claim to a named worker (handoff)",
  description:
    "Hand this proposal's claim to a named target worker (reason required, audited). The current holder (or a human director) may release; the lease transfers to the target.",
  request: {
    params: z.object({ id: proposalIdParam }),
    body: {
      content: { "application/json": { schema: releaseToBody } },
    },
  },
  responses: {
    200: {
      description: "Release-to outcome",
      content: { "application/json": { schema: forceClaimResultEnvelope } },
    },
    400: {
      description: "Validation error (empty reason / missing target)",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Forbidden (non-holder agent)",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Proposal or target user not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Proposal closed / not associated with a project",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const requestTakeoverProposalRoute = createRoute({
  method: "post",
  path: "/api/v1/proposals/{id}/request-takeover",
  tags: ["Proposals"],
  summary: "Request takeover of a proposal claim (stomp-safe)",
  description:
    "Ask to take over this proposal's claim. A stale (lease-lapsed) claim is auto-granted to the caller; a LIVE claim is NEVER mutated — the holder is notified and the result is notified_holder.",
  request: {
    params: z.object({ id: proposalIdParam }),
    body: {
      content: { "application/json": { schema: requestTakeoverBody } },
    },
  },
  responses: {
    200: {
      description: "Takeover-request outcome",
      content: {
        "application/json": { schema: requestTakeoverResultEnvelope },
      },
    },
    400: {
      description: "Validation error (empty reason)",
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
    const { status, claim } = c.req.valid("query");
    const user = c.get("currentUser");
    const proposalsList = proposalService.list(
      projectId,
      { status, claim },
      user ? { id: user.id } : null,
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
    const user = c.get("currentUser");
    // Derive createdBy: AI agents always self-attribute; humans may pass an
    // explicit createdBy to create on behalf of someone else.
    const createdBy = user?.type === "ai_agent" ? user.id : (body.createdBy ?? user?.id);
    if (!createdBy) {
      return c.json(
        {
          error: {
            code: "MISSING_CREATED_BY",
            message: "createdBy could not be determined from auth context",
          },
        },
        400,
      );
    }
    const proposal = proposalService.create(projectId, {
      ...body,
      createdBy,
    });

    return c.json(
      {
        data: proposalService.withClaimStatus(proposal, user ? { id: user.id } : null),
      },
      201,
    );
  });

  // GET /api/v1/proposals/:id
  router.openapi(getProposalRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser");
    const proposal = proposalService.getById(id, user ? { id: user.id } : null);

    return c.json({ data: proposal }, 200);
  });

  // PATCH /api/v1/proposals/:id
  router.openapi(updateProposalRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser");
    const proposal = proposalService.update(id, body);

    return c.json(
      {
        data: proposalService.withClaimStatus(proposal, user ? { id: user.id } : null),
      },
      200,
    );
  });

  // POST /api/v1/proposals/:id/transitions
  router.openapi(transitionProposalRoute, (c) => {
    const { id } = c.req.valid("param");
    const { toStatus } = c.req.valid("json");
    const user = c.get("currentUser");

    const proposal = proposalService.transition(id, toStatus, {
      id: user!.id,
      type: user!.type as UserType,
    });

    return c.json(
      {
        data: proposalService.withClaimStatus(proposal, { id: user!.id }),
      },
      200,
    );
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
    const user = c.get("currentUser");
    const comment = proposalService.addComment(id, {
      ...body,
      authorId: user!.id,
    });

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
    const { epics, tasks } = c.req.valid("json");
    const user = c.get("currentUser");
    const proposal = proposalService.implementProposal(id, epics, tasks, {
      id: user!.id,
      type: user!.type as UserType,
    });

    return c.json(
      {
        data: proposalService.withClaimStatus(proposal, { id: user!.id }),
      },
      200,
    );
  });

  // POST /api/v1/proposals/:id/claim
  router.openapi(claimProposalRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser");
    const result = proposalService.claim(id, {
      id: user!.id,
      type: user!.type as UserType,
    });

    return c.json({ data: result }, 200);
  });

  // POST /api/v1/proposals/:id/force-claim
  router.openapi(forceClaimProposalRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser");
    const result = proposalService.forceClaim(
      id,
      { id: user!.id, type: user!.type as UserType },
      { reason: body.reason, newAssigneeId: body.newAssigneeId },
    );

    return c.json({ data: result }, 200);
  });

  // POST /api/v1/proposals/:id/release
  router.openapi(releaseProposalRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser");
    const result = proposalService.release(id, {
      id: user!.id,
      type: user!.type as UserType,
    });

    return c.json({ data: result }, 200);
  });

  // POST /api/v1/proposals/:id/release-to
  router.openapi(releaseToProposalRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser");
    const result = proposalService.releaseTo(
      id,
      { id: user!.id, type: user!.type as UserType },
      { reason: body.reason, targetId: body.targetId },
    );
    return c.json({ data: result }, 200);
  });

  // POST /api/v1/proposals/:id/request-takeover
  router.openapi(requestTakeoverProposalRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser");
    const result = proposalService.requestTakeover(
      id,
      { id: user!.id, type: user!.type as UserType },
      { reason: body.reason },
    );
    return c.json({ data: result }, 200);
  });

  return router;
}
