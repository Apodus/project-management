import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  NOTE_KINDS,
  NOTE_STATUSES,
  NOTE_ANCHOR_TYPES,
  NOTE_SEVERITIES,
} from "@pm/shared";
import type { AppVariables } from "../types.js";
import * as noteService from "../services/note.service.js";

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
  })
  .openapi("Note");

const noteDataEnvelope = z.object({
  data: noteSchema,
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

const listNotesQuery = z.object({
  kind: z.enum(NOTE_KINDS).optional(),
  status: z.enum(NOTE_STATUSES).optional(),
  anchorType: z.enum(NOTE_ANCHOR_TYPES).optional(),
  anchorId: z.string().optional(),
  severity: z.enum(NOTE_SEVERITIES).optional(),
});

const projectIdParam = z.string().min(1).openapi({
  param: { name: "projectId", in: "path" },
  example: "01HXYZ1234567890ABCDEFGHIJ",
});

const noteIdParam = z.string().min(1).openapi({
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
      description: "Note created",
      content: { "application/json": { schema: noteDataEnvelope } },
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
    "Update an OPEN note's fields. A triaged note is immutable in C1 (409). Status is not patchable.",
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
      description: "Note is not open and cannot be edited",
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
    // Author is always the caller — never accepted from the body.
    const note = noteService.create(projectId, body, user.id);
    return c.json({ data: note }, 201);
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

  return router;
}
