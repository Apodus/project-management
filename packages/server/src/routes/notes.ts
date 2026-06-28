import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  NOTE_KINDS,
  NOTE_STATUSES,
  NOTE_ANCHOR_TYPES,
  NOTE_SEVERITIES,
  NOTE_TRIAGE_OUTCOMES,
} from "@pm/shared";
import type { UserType } from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as noteService from "../services/note.service.js";
import * as notesHealthService from "../services/notes-health.service.js";

// ─── Notes routes (Campaign C1 §P3) ───────────────────────────────
// Route-local Zod-4 schemas (via @hono/zod-openapi `z`), the established
// split from the canonical Zod-3 @pm/shared note schema. Capture + read only;
// PATCH guards open-only (409 on a triaged note). Notes are ownerless in C1.

// ─── Response schemas ─────────────────────────────────────────────

const codeLocatorSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  commitSha: z.string().optional(),
});

// Anchor/promoted-target enrichment ref (Campaign C4). Route-local Zod-4
// mirror of @pm/shared `noteAnchorRefSchema` (the established split).
const anchorRefSchema = z
  .object({
    exists: z.boolean(),
    title: z.string().nullable(),
  })
  .openapi("NoteAnchorRef");

const noteSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    kind: z.enum(NOTE_KINDS),
    status: z.enum(NOTE_STATUSES),
    title: z.string(),
    body: z.string().nullable(),
    anchorType: z.enum(NOTE_ANCHOR_TYPES).nullable(),
    anchorId: z.string().nullable(),
    codeLocator: codeLocatorSchema.nullable(),
    severity: z.enum(NOTE_SEVERITIES).nullable(),
    authorId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    triagedAt: z.string().nullable(),
    triagedBy: z.string().nullable(),
    triageOutcome: z.enum(NOTE_TRIAGE_OUTCOMES).nullable(),
    triageReason: z.string().nullable(),
    promotedProposalId: z.string().nullable(),
    promotedTaskId: z.string().nullable(),
    anchor: anchorRefSchema.nullable().optional().openapi({
      description:
        "Server-derived anchor truth (C4): { exists, title } for (anchorType, anchorId); null when unanchored. Absent on non-enriched responses (create/patch); exists:false means the target was deleted.",
    }),
    promotedTarget: anchorRefSchema.nullable().optional().openapi({
      description:
        "Server-derived promoted-target truth (C4): { exists, title } for promotedTaskId/promotedProposalId; null when not promoted. Absent on non-enriched responses (create/patch); exists:false means the target was deleted.",
    }),
  })
  .openapi("Note");

const noteDataEnvelope = z.object({
  data: noteSchema,
});

const similarNoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(NOTE_KINDS),
});

const createNoteResponseEnvelope = z.object({
  data: noteSchema,
  similar: z.array(similarNoteSchema),
});

const noteListEnvelope = z.object({
  data: z.array(noteSchema),
  pagination: z.object({
    total: z.number(),
  }),
});

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Notes-health (Campaign C2 §P5) ───────────────────────────────
// snake_case on the wire (matches claims-health). Route-local Zod-4 mirror.
const notesHealthSchema = z
  .object({
    open_count: z.number(),
    oldest_untriaged_age_ms: z.number().nullable(),
  })
  .openapi("NotesHealth");

const notesHealthEnvelope = z.object({ data: notesHealthSchema });

// ─── Request schemas ──────────────────────────────────────────────

const createNoteBody = z
  .object({
    kind: z.enum(NOTE_KINDS),
    title: z.string().min(1, "Title is required"),
    body: z.string().nullable().optional(),
    anchorType: z.enum(NOTE_ANCHOR_TYPES).nullable().optional(),
    anchorId: z.string().nullable().optional(),
    codeLocator: codeLocatorSchema.nullable().optional(),
    severity: z.enum(NOTE_SEVERITIES).nullable().optional(),
  })
  .openapi("CreateNote");

const patchNoteBody = z
  .object({
    kind: z.enum(NOTE_KINDS).optional(),
    title: z.string().min(1).optional(),
    body: z.string().nullable().optional(),
    anchorType: z.enum(NOTE_ANCHOR_TYPES).nullable().optional(),
    anchorId: z.string().nullable().optional(),
    codeLocator: codeLocatorSchema.nullable().optional(),
    severity: z.enum(NOTE_SEVERITIES).nullable().optional(),
  })
  .openapi("PatchNote");

const dismissNoteBody = z.object({ reason: z.string().min(1) }).openapi("DismissNote");

const promoteToProposalBody = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .openapi("PromoteNoteToProposal");

// MINIMAL inline proposal schema for the promote response. NOT the proposal
// route's full schema (which requires claimStatus/claimState the raw create row
// lacks). projectId AND sourceNoteId are nullable (the columns are nullable).
const promotedProposalSchema = z
  .object({
    id: z.string(),
    projectId: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    createdBy: z.string(),
    sourceNoteId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("PromotedProposal");

const promoteToProposalResponseEnvelope = z.object({
  data: noteSchema,
  proposal: promotedProposalSchema,
});

const promoteToTaskBody = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    epicId: z.string().min(1).optional(),
  })
  .openapi("PromoteNoteToTask");

// MINIMAL inline task schema for the promote response (mirror of
// promotedProposalSchema). tasks.projectId is NOT NULL → z.string(); epicId and
// sourceNoteId are nullable (the columns are nullable). The response is not
// rejected for extra keys, so the enriched claimStatus/claimState from create
// pass through harmlessly.
const promotedTaskSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    priority: z.string(),
    type: z.string(),
    reporterId: z.string(),
    epicId: z.string().nullable(),
    sourceNoteId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("PromotedTask");

const promoteToTaskResponseEnvelope = z.object({
  data: noteSchema,
  task: promotedTaskSchema,
});

const listNotesQuery = z.object({
  kind: z.enum(NOTE_KINDS).optional(),
  status: z.enum(NOTE_STATUSES).optional(),
  anchorType: z.enum(NOTE_ANCHOR_TYPES).optional(),
  anchorId: z.string().optional(),
  severity: z.enum(NOTE_SEVERITIES).optional(),
});

const projectIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "projectId", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

const noteIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "id", in: "path" },
    example: "01HXYZ1234567890ABCDEFGHIJ",
  });

// ─── Route definitions ────────────────────────────────────────────

const createNoteRoute = createRoute({
  method: "post",
  path: "/api/v1/projects/{projectId}/notes",
  tags: ["Notes"],
  summary: "Create note",
  description: "Capture a new note (bug/question/idea/tech_debt/wtf/observation) for a project.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    body: {
      content: { "application/json": { schema: createNoteBody } },
      required: true,
    },
  },
  responses: {
    201: {
      description: "Note created (with advisory `similar` open-note candidates)",
      content: { "application/json": { schema: createNoteResponseEnvelope } },
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

const getNoteRoute = createRoute({
  method: "get",
  path: "/api/v1/notes/{id}",
  tags: ["Notes"],
  summary: "Get note",
  description: "Get a single note by ID.",
  request: {
    params: z.object({ id: noteIdParam }),
  },
  responses: {
    200: {
      description: "Note",
      content: { "application/json": { schema: noteDataEnvelope } },
    },
    404: {
      description: "Note not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const listNotesRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/notes",
  tags: ["Notes"],
  summary: "List notes",
  description: "List notes for a project, newest first, with optional filters.",
  request: {
    params: z.object({ projectId: projectIdParam }),
    query: listNotesQuery,
  },
  responses: {
    200: {
      description: "List of notes",
      content: { "application/json": { schema: noteListEnvelope } },
    },
  },
});

const patchNoteRoute = createRoute({
  method: "patch",
  path: "/api/v1/notes/{id}",
  tags: ["Notes"],
  summary: "Update note",
  description:
    "Update a mutable note's fields (open or needs_human). A triaged note is immutable (409). Status is not patchable (flag/reopen own the status transitions).",
  request: {
    params: z.object({ id: noteIdParam }),
    body: {
      content: { "application/json": { schema: patchNoteBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Note updated",
      content: { "application/json": { schema: noteDataEnvelope } },
    },
    404: {
      description: "Note not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Note is triaged (terminal) and cannot be modified",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const dismissNoteRoute = createRoute({
  method: "post",
  path: "/api/v1/notes/{id}/dismiss",
  tags: ["Notes"],
  summary: "Dismiss note",
  description:
    "Terminally dismiss a mutable note (open or needs_human) — triage outcome `dismissed`. Anti-signal-burying: only the note's author OR a human may dismiss.",
  request: {
    params: z.object({ id: noteIdParam }),
    body: {
      content: { "application/json": { schema: dismissNoteBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Note dismissed",
      content: { "application/json": { schema: noteDataEnvelope } },
    },
    400: {
      description: "Validation error",
      content: { "application/json": { schema: errorEnvelope } },
    },
    403: {
      description: "Caller is not allowed to dismiss this note",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Note not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Note is triaged (terminal) and cannot be dismissed",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const promoteToProposalRoute = createRoute({
  method: "post",
  path: "/api/v1/notes/{id}/promote-to-proposal",
  tags: ["Notes"],
  summary: "Promote note to proposal",
  description:
    "Terminally promote a mutable note (open or needs_human) to a new proposal (triage outcome `promoted`). Records bidirectional provenance (note.promotedProposalId ⇆ proposal.sourceNoteId). No authz gate — promote elevates signal, so any authenticated caller may.",
  request: {
    params: z.object({ id: noteIdParam }),
    body: {
      content: { "application/json": { schema: promoteToProposalBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Note promoted; proposal created",
      content: { "application/json": { schema: promoteToProposalResponseEnvelope } },
    },
    404: {
      description: "Note not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Note is triaged (terminal) and cannot be promoted",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const promoteToTaskRoute = createRoute({
  method: "post",
  path: "/api/v1/notes/{id}/promote-to-task",
  tags: ["Notes"],
  summary: "Promote note to task",
  description:
    "HUMAN-ONLY escape hatch: terminally promote a mutable note (open or needs_human) directly to a new task (triage outcome `promoted`), recording provenance (task.sourceNoteId). Not exposed via MCP — preserves the proposal gate (no ai-reachable path mints a task from a note). A non-human caller gets 403.",
  request: {
    params: z.object({ id: noteIdParam }),
    body: {
      content: { "application/json": { schema: promoteToTaskBody } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Note promoted; task created",
      content: { "application/json": { schema: promoteToTaskResponseEnvelope } },
    },
    403: {
      description: "Caller is not allowed to promote this note to a task (human-only)",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Note not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Note is triaged (terminal) and cannot be promoted",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const flagNeedsHumanRoute = createRoute({
  method: "post",
  path: "/api/v1/notes/{id}/flag-needs-human",
  tags: ["Notes"],
  summary: "Flag note needs_human",
  description:
    "Raise an OPEN note's signal to needs_human — an agent that triaged the note but cannot resolve it punts it to a human. Sets no triage metadata (the note stays mutable/triageable). No authz gate (flag elevates signal). 409 if the note is not open (already needs_human or terminally triaged).",
  request: {
    params: z.object({ id: noteIdParam }),
  },
  responses: {
    200: {
      description: "Note flagged needs_human",
      content: { "application/json": { schema: noteDataEnvelope } },
    },
    404: {
      description: "Note not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Note is not open and cannot be flagged needs_human",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const reopenNoteRoute = createRoute({
  method: "post",
  path: "/api/v1/notes/{id}/reopen",
  tags: ["Notes"],
  summary: "Reopen note",
  description:
    "HUMAN-ONLY: reopen a needs_human or triaged note back to open, clearing the note's triage metadata. Does NOT delete any proposal/task a prior promote spawned (it stays independently reviewable). A non-human caller gets 403. 409 if the note is already open (not reopenable).",
  request: {
    params: z.object({ id: noteIdParam }),
  },
  responses: {
    200: {
      description: "Note reopened",
      content: { "application/json": { schema: noteDataEnvelope } },
    },
    403: {
      description: "Caller is not allowed to reopen this note (human-only)",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Note not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
    409: {
      description: "Note is already open and is not reopenable",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

const notesHealthRoute = createRoute({
  method: "get",
  path: "/api/v1/projects/{projectId}/notes/health",
  tags: ["Notes"],
  summary: "Notes backlog health",
  description:
    "Read the project's notes-backlog health (open-note count + oldest-open age). SIDE EFFECT: fires the edge-triggered `note.backlog_alert` (SSE + Discord) exactly ONCE per backlog episode when an open note ages past the backlog threshold; the latch re-arms when the backlog clears.",
  request: {
    params: z.object({ projectId: projectIdParam }),
  },
  responses: {
    200: {
      description: "Notes backlog health",
      content: { "application/json": { schema: notesHealthEnvelope } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: errorEnvelope } },
    },
    404: {
      description: "Project not found",
      content: { "application/json": { schema: errorEnvelope } },
    },
  },
});

// ─── Router ───────────────────────────────────────────────────────

export function createNoteRoutes(): OpenAPIHono<{
  Variables: AppVariables;
}> {
  const router = new OpenAPIHono<{ Variables: AppVariables }>();

  // POST /api/v1/projects/:projectId/notes
  router.openapi(createNoteRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser")!;
    // Advisory dedup BEFORE create (so the new note never matches itself);
    // `similar` is always present (`[]` when none) and never blocks the 201.
    const similar = noteService.findSimilarOpenNotes(projectId, `${body.title} ${body.body ?? ""}`);
    // Author is always the caller — never accepted from the body.
    const note = noteService.create(projectId, body, user.id);
    return c.json({ data: note, similar }, 201);
  });

  // GET /api/v1/notes/:id
  router.openapi(getNoteRoute, (c) => {
    const { id } = c.req.valid("param");
    return c.json({ data: noteService.getById(id) }, 200);
  });

  // GET /api/v1/projects/:projectId/notes
  router.openapi(listNotesRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const query = c.req.valid("query");
    const list = noteService.list(projectId, query);
    return c.json({ data: list, pagination: { total: list.length } }, 200);
  });

  // PATCH /api/v1/notes/:id
  router.openapi(patchNoteRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser")!;
    return c.json({ data: noteService.update(id, body, user.id) }, 200);
  });

  // POST /api/v1/notes/:id/dismiss
  router.openapi(dismissNoteRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser");
    const note = noteService.dismiss(
      id,
      { id: user!.id, type: user!.type as UserType },
      body.reason,
    );
    return c.json({ data: note }, 200);
  });

  // POST /api/v1/notes/:id/promote-to-proposal
  router.openapi(promoteToProposalRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser");
    const { note, proposal } = noteService.promoteToProposal(
      id,
      { id: user!.id, type: user!.type as UserType },
      body,
    );
    return c.json({ data: note, proposal }, 200);
  });

  // POST /api/v1/notes/:id/promote-to-task (HUMAN-ONLY escape hatch)
  router.openapi(promoteToTaskRoute, (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const user = c.get("currentUser");
    const { note, task } = noteService.promoteToTask(
      id,
      { id: user!.id, type: user!.type as UserType },
      body,
    );
    return c.json({ data: note, task }, 200);
  });

  // POST /api/v1/notes/:id/flag-needs-human (T1 — needs_human lane)
  router.openapi(flagNeedsHumanRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser");
    const note = noteService.flagNeedsHuman(id, { id: user!.id, type: user!.type as UserType });
    return c.json({ data: note }, 200);
  });

  // POST /api/v1/notes/:id/reopen (T1 — human-only reopen)
  router.openapi(reopenNoteRoute, (c) => {
    const { id } = c.req.valid("param");
    const user = c.get("currentUser");
    const note = noteService.reopen(id, { id: user!.id, type: user!.type as UserType });
    return c.json({ data: note }, 200);
  });

  // GET /api/v1/projects/:projectId/notes/health (Campaign C2 §P5)
  router.openapi(notesHealthRoute, (c) => {
    const { projectId } = c.req.valid("param");
    const health = notesHealthService.computeNotesHealth(projectId);
    return c.json(
      {
        data: {
          open_count: health.openCount,
          oldest_untriaged_age_ms: health.oldestUntriagedAgeMs,
        },
      },
      200,
    );
  });

  return router;
}
