import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestApp,
  createTestProject,
  createTestUser,
  createTestEpic,
  createTestAiAgent,
  authRequest,
  type TestApp,
} from "../utils.js";
import { epics, notes, proposals, tasks } from "../../src/db/index.js";
import { AppError } from "../../src/types.js";
import * as noteService from "../../src/services/note.service.js";
import * as taskService from "../../src/services/task.service.js";

// ──────────────────────────────────────────────────────────────────
// Campaign C2 §P4 — THE STRUCTURAL SEAL for the proposal gate.
//
// The invariant: a note feeds PROPOSAL creation for any caller (AI or human),
// but a note → TASK is a HUMAN-ONLY escape hatch with NO ai-reachable path and
// NO MCP surface. The `sourceNoteId` provenance column on tasks/proposals must
// NOT be client-settable through the create routes (a mass-assignment of it
// would let a client forge provenance / bypass the human gate). The wire-level
// (d) assertions are where the seal actually lives — they are the regression
// tripwire if a future change adds .passthrough() or a new spread.
// ──────────────────────────────────────────────────────────────────

describe("proposal gate invariant", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // (a) No AI path mints a task from a note.
  it("forbids an ai_agent from promoting a note to a task (403, zero side effects)", () => {
    const project = createTestProject(testApp.db);
    const agent = createTestUser(testApp.db, { type: "ai_agent" });
    const note = noteService.create(project.id, { kind: "bug", title: "agent finding" }, agent.id);

    const before = testApp.db.select().from(tasks).all().length;

    try {
      noteService.promoteToTask(note.id, { id: agent.id, type: "ai_agent" });
      expect.unreachable("should have thrown 403");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(403);
      expect((err as AppError).code).toBe("FORBIDDEN");
    }

    // Zero side effects: no task minted, the note is still open.
    const after = testApp.db.select().from(tasks).all().length;
    expect(after).toBe(before);
    const reread = testApp.db.select().from(notes).where(eq(notes.id, note.id)).get()!;
    expect(reread.status).toBe("open");
  });

  // (b) promoteToProposal creates NO task/epic.
  it("promoteToProposal spawns a proposal but never a task or epic", () => {
    const project = createTestProject(testApp.db);
    const author = createTestUser(testApp.db, { type: "human" });
    const note = noteService.create(
      project.id,
      { kind: "idea", title: "feed a proposal" },
      author.id,
    );

    const epicsBefore = testApp.db.select().from(epics).all().length;
    const tasksBefore = testApp.db.select().from(tasks).all().length;
    const proposalsBefore = testApp.db.select().from(proposals).all().length;

    noteService.promoteToProposal(note.id, { id: author.id, type: "human" });

    expect(testApp.db.select().from(epics).all().length).toBe(epicsBefore);
    expect(testApp.db.select().from(tasks).all().length).toBe(tasksBefore);
    expect(testApp.db.select().from(proposals).all().length).toBe(proposalsBefore + 1);
  });

  // (c-service) human promoteToTask persists provenance; a plain create persists null.
  it("human promoteToTask persists task.sourceNoteId; a plain create leaves it null", () => {
    const project = createTestProject(testApp.db);
    const human = createTestUser(testApp.db, { type: "human" });
    const note = noteService.create(project.id, { kind: "bug", title: "promote me" }, human.id);

    const { note: triaged, task } = noteService.promoteToTask(note.id, {
      id: human.id,
      type: "human",
    });

    // sourceNoteId persisted (re-select from the table, not the return value).
    const reread = testApp.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    expect(reread.sourceNoteId).toBe(note.id);

    // The note is terminally triaged with the promoted-task back-pointer.
    expect(triaged.status).toBe("triaged");
    expect(triaged.triageOutcome).toBe("promoted");
    expect(triaged.promotedTaskId).toBe(task.id);

    // A plain create WITHOUT sourceNoteId → persisted null.
    const plain = taskService.create({
      projectId: project.id,
      title: "no provenance",
      reporterId: human.id,
    });
    const plainReread = testApp.db.select().from(tasks).where(eq(tasks.id, plain.id)).get()!;
    expect(plainReread.sourceNoteId).toBeNull();
  });

  // (d-WIRE — the real seal) the create routes strip a client-supplied
  // sourceNoteId so it can never be mass-assigned bypassing the human gate.
  it("POST /tasks strips a client-supplied sourceNoteId (persisted null)", async () => {
    const project = createTestProject(testApp.db);
    const note = noteService.create(
      project.id,
      { kind: "bug", title: "real note for the wire seal" },
      testApp.testUser.id,
    );

    const res = await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/tasks`, {
      body: { title: "forge provenance", sourceNoteId: note.id },
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    const reread = testApp.db.select().from(tasks).where(eq(tasks.id, body.data.id)).get()!;
    expect(reread.sourceNoteId).toBeNull();
  });

  it("POST /proposals strips a client-supplied sourceNoteId (persisted null)", async () => {
    const project = createTestProject(testApp.db);
    const note = noteService.create(
      project.id,
      { kind: "bug", title: "real note for the proposal wire seal" },
      testApp.testUser.id,
    );

    const res = await authRequest(testApp.app, "POST", `/api/v1/projects/${project.id}/proposals`, {
      body: { title: "forge provenance", sourceNoteId: note.id },
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    const reread = testApp.db.select().from(proposals).where(eq(proposals.id, body.data.id)).get()!;
    expect(reread.sourceNoteId).toBeNull();
  });

  // Confirm the human-only gate also fires through the wire (not just the service).
  it("POST /notes/:id/promote-to-task returns 403 for an ai_agent token (no task created)", async () => {
    const project = createTestProject(testApp.db);
    const agent = createTestAiAgent(testApp.db);
    const note = noteService.create(
      project.id,
      { kind: "bug", title: "agent wire promote" },
      agent.user.id,
    );

    const before = testApp.db.select().from(tasks).all().length;

    const res = await authRequest(testApp.app, "POST", `/api/v1/notes/${note.id}/promote-to-task`, {
      token: agent.token,
      body: {},
    });
    expect(res.status).toBe(403);

    expect(testApp.db.select().from(tasks).all().length).toBe(before);
  });
});
