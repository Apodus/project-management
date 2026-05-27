import { eq, and } from "drizzle-orm";
import { createId } from "@pm/shared";
import {
  PROPOSAL_TRANSITION_MAP,
  type ProposalStatus,
  type UserType,
} from "@pm/shared";
import {
  getDb,
  projects,
  proposals,
  comments,
  epics,
  tasks,
  users,
} from "../db/index.js";
import { AppError } from "../types.js";
import { getEventBus, EVENT_NAMES } from "../events/event-bus.js";

// ─── Types ────────────────────────────────────────────────────────

export interface CreateProposalInput {
  title: string;
  description?: string | null;
  createdBy: string;
}

export interface UpdateProposalInput {
  title?: string;
  description?: string | null;
}

export interface AddCommentInput {
  authorId: string;
  body: string;
  commentType?: string;
}

export interface EpicInput {
  name: string;
  description?: string | null;
  priority?: string;
  status?: string;
}

export interface TaskInput {
  title: string;
  description?: string | null;
  priority?: string;
  type?: string;
  epicIndex?: number; // index into the epics array to link to
}

// ─── Service functions ────────────────────────────────────────────

/**
 * List proposals for a project, with optional status filter.
 */
export function list(projectId: string, filters?: { status?: string }) {
  const db = getDb();

  if (filters?.status) {
    return db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.projectId, projectId),
          eq(proposals.status, filters.status),
        ),
      )
      .all();
  }

  return db
    .select()
    .from(proposals)
    .where(eq(proposals.projectId, projectId))
    .all();
}

/**
 * Get a single proposal by ID with comments and linked work items.
 * Throws 404 if not found.
 */
export function getById(id: string) {
  const db = getDb();
  const proposal = db
    .select()
    .from(proposals)
    .where(eq(proposals.id, id))
    .get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${id}`);
  }

  // Get comments
  const proposalComments = db
    .select()
    .from(comments)
    .where(eq(comments.proposalId, id))
    .all();

  // Get linked epics
  const linkedEpics = db
    .select()
    .from(epics)
    .where(eq(epics.proposalId, id))
    .all();

  // Get linked tasks
  const linkedTasks = db
    .select()
    .from(tasks)
    .where(eq(tasks.proposalId, id))
    .all();

  return {
    ...proposal,
    comments: proposalComments,
    workItems: {
      epics: linkedEpics,
      tasks: linkedTasks,
    },
  };
}

/**
 * Create a new proposal.
 * Validates that the project exists.
 */
export function create(projectId: string, data: CreateProposalInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const id = createId();

  // Validate project exists
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (!project) {
    throw new AppError(404, "NOT_FOUND", `Project not found: ${projectId}`);
  }

  db.insert(proposals)
    .values({
      id,
      projectId,
      title: data.title,
      description: data.description ?? null,
      status: "open",
      createdBy: data.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const result = db
    .select()
    .from(proposals)
    .where(eq(proposals.id, id))
    .get()!;

  getEventBus().emit(EVENT_NAMES.PROPOSAL_CREATED, {
    entity: result,
    entityType: "proposal",
    entityId: id,
    projectId,
    actorId: data.createdBy,
    timestamp: now,
  });

  return result;
}

/**
 * Update a proposal's title/description.
 * Throws 404 if not found.
 */
export function update(id: string, data: UpdateProposalInput) {
  const db = getDb();

  // Verify proposal exists
  const existing = db
    .select()
    .from(proposals)
    .where(eq(proposals.id, id))
    .get();

  if (!existing) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${id}`);
  }

  const now = new Date().toISOString();
  const values: Record<string, unknown> = { updatedAt: now };

  if (data.title !== undefined) values.title = data.title;
  if (data.description !== undefined) values.description = data.description;

  db.update(proposals)
    .set(values)
    .where(eq(proposals.id, id))
    .run();

  return db
    .select()
    .from(proposals)
    .where(eq(proposals.id, id))
    .get()!;
}

/**
 * Transition a proposal to a new status.
 * THE CORE LOGIC:
 * - Validates the transition is allowed per PROPOSAL_TRANSITION_MAP
 * - Validates the actor's user type is allowed for this transition
 * - If transitioning to accepted/rejected, sets resolved_by and resolved_at
 * - Updates status and updated_at
 */
export function transition(
  id: string,
  toStatus: ProposalStatus,
  actor: { id: string; type: UserType },
) {
  const db = getDb();

  // Get current proposal
  const proposal = db
    .select()
    .from(proposals)
    .where(eq(proposals.id, id))
    .get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${id}`);
  }

  const fromStatus = proposal.status as ProposalStatus;

  // Check if the transition is valid at all
  const rule = PROPOSAL_TRANSITION_MAP.get(`${fromStatus}->${toStatus}`);
  if (!rule) {
    throw new AppError(
      400,
      "INVALID_TRANSITION",
      `Cannot transition proposal from "${fromStatus}" to "${toStatus}"`,
    );
  }

  // Check if the actor's type is allowed for this transition
  if (!rule.allowedBy.includes(actor.type)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      `User type "${actor.type}" is not allowed to transition proposal from "${fromStatus}" to "${toStatus}"`,
    );
  }

  const now = new Date().toISOString();
  const values: Record<string, unknown> = {
    status: toStatus,
    updatedAt: now,
  };

  // Set resolved_by and resolved_at when transitioning to accepted or rejected
  if (toStatus === "accepted" || toStatus === "rejected") {
    values.resolvedBy = actor.id;
    values.resolvedAt = now;
  }

  db.update(proposals)
    .set(values)
    .where(eq(proposals.id, id))
    .run();

  const result = db
    .select()
    .from(proposals)
    .where(eq(proposals.id, id))
    .get()!;

  getEventBus().emit(EVENT_NAMES.PROPOSAL_TRANSITIONED, {
    entity: result,
    entityType: "proposal",
    entityId: id,
    projectId: proposal.projectId,
    actorId: actor.id,
    timestamp: now,
    changes: { status: { from: fromStatus, to: toStatus } },
    previousStatus: fromStatus,
  });

  return result;
}

/**
 * Add a comment to a proposal.
 * If proposal status is "open" and the commenter is an AI agent,
 * auto-transition to "discussing".
 */
export function addComment(proposalId: string, data: AddCommentInput) {
  const db = getDb();
  const now = new Date().toISOString();
  const commentId = createId();

  // Verify proposal exists
  const proposal = db
    .select()
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${proposalId}`);
  }

  // Insert the comment
  db.insert(comments)
    .values({
      id: commentId,
      proposalId,
      authorId: data.authorId,
      body: data.body,
      commentType: data.commentType ?? "comment",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // Auto-transition: if proposal is "open" and commenter is AI agent, move to "discussing"
  if (proposal.status === "open") {
    // Look up the commenter's type
    const author = db
      .select()
      .from(users)
      .where(eq(users.id, data.authorId))
      .get();

    if (author && author.type === "ai_agent") {
      db.update(proposals)
        .set({ status: "discussing", updatedAt: now })
        .where(eq(proposals.id, proposalId))
        .run();
    }
  }

  return db
    .select()
    .from(comments)
    .where(eq(comments.id, commentId))
    .get()!;
}

/**
 * List comments for a proposal.
 */
export function listComments(proposalId: string) {
  const db = getDb();

  // Verify proposal exists
  const proposal = db
    .select()
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${proposalId}`);
  }

  return db
    .select()
    .from(comments)
    .where(eq(comments.proposalId, proposalId))
    .all();
}

/**
 * List epics and tasks spawned from this proposal.
 */
export function getWorkItems(proposalId: string) {
  const db = getDb();

  // Verify proposal exists
  const proposal = db
    .select()
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${proposalId}`);
  }

  const linkedEpics = db
    .select()
    .from(epics)
    .where(eq(epics.proposalId, proposalId))
    .all();

  const linkedTasks = db
    .select()
    .from(tasks)
    .where(eq(tasks.proposalId, proposalId))
    .all();

  return {
    epics: linkedEpics,
    tasks: linkedTasks,
  };
}

/**
 * Implement a proposal by atomically creating epics and tasks from it.
 * 1. Verify proposal is in "accepted" status
 * 2. Create epics with proposal_id set
 * 3. Create tasks (under epics or standalone) with proposal_id set
 * 4. Transition proposal to "planned"
 * 5. Add a summary comment
 * All in a single transaction.
 */
export function implementProposal(
  proposalId: string,
  epicInputs: EpicInput[],
  taskInputs: TaskInput[],
  actorId: string,
) {
  const db = getDb();

  // Verify proposal exists and is in "accepted" status
  const proposal = db
    .select()
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .get();

  if (!proposal) {
    throw new AppError(404, "NOT_FOUND", `Proposal not found: ${proposalId}`);
  }

  if (proposal.status !== "accepted") {
    throw new AppError(
      400,
      "INVALID_STATUS",
      `Proposal must be in "accepted" status to implement, currently "${proposal.status}"`,
    );
  }

  const projectId = proposal.projectId;
  if (!projectId) {
    throw new AppError(
      400,
      "NO_PROJECT",
      `Proposal has no project associated`,
    );
  }

  const now = new Date().toISOString();
  const createdEpicIds: string[] = [];
  const createdTaskIds: string[] = [];

  // Run everything in a transaction
  db.transaction((tx) => {
    // Create epics
    for (const epicInput of epicInputs) {
      const epicId = createId();
      createdEpicIds.push(epicId);

      tx.insert(epics)
        .values({
          id: epicId,
          projectId,
          proposalId,
          name: epicInput.name,
          description: epicInput.description ?? null,
          status: epicInput.status ?? "draft",
          priority: epicInput.priority ?? "medium",
          createdAt: now,
          updatedAt: now,
          createdBy: actorId,
        })
        .run();
    }

    // Create tasks
    for (const taskInput of taskInputs) {
      const taskId = createId();
      createdTaskIds.push(taskId);

      // If epicIndex is specified, link to the created epic
      const epicId =
        taskInput.epicIndex !== undefined
          ? createdEpicIds[taskInput.epicIndex]
          : undefined;

      tx.insert(tasks)
        .values({
          id: taskId,
          projectId,
          proposalId,
          epicId: epicId ?? null,
          title: taskInput.title,
          description: taskInput.description ?? null,
          status: "backlog",
          priority: taskInput.priority ?? "medium",
          type: taskInput.type ?? "feature",
          reporterId: actorId,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // Transition proposal to "planned"
    tx.update(proposals)
      .set({
        status: "planned",
        updatedAt: now,
      })
      .where(eq(proposals.id, proposalId))
      .run();

    // Add a summary comment
    const commentId = createId();
    const epicCount = epicInputs.length;
    const taskCount = taskInputs.length;
    const summaryParts: string[] = [];
    if (epicCount > 0) summaryParts.push(`${epicCount} epic(s)`);
    if (taskCount > 0) summaryParts.push(`${taskCount} task(s)`);
    const summaryText = `Proposal planned: created ${summaryParts.join(" and ")}.`;

    tx.insert(comments)
      .values({
        id: commentId,
        proposalId,
        authorId: actorId,
        body: summaryText,
        commentType: "decision",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });

  // Return the updated proposal
  return db
    .select()
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .get()!;
}
