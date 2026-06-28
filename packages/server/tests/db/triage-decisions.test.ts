import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createId } from "@pm/shared";
import {
  initializeDatabase,
  closeDb,
  workspaces,
  users,
  projects,
  proposals,
  tasks,
  notes,
  triageDecisions,
} from "../../src/db/index.js";
import type { AppDatabase } from "../../src/db/index.js";

function now(): string {
  return new Date().toISOString();
}

function setupDb(): AppDatabase {
  return initializeDatabase({ inMemory: true });
}

// ──────────────────────────────────────────────────────────────────
// T2·P1: the triage_decisions side-log table. The append-only contract T3
// reads. These tests pin the column shape (all columns round-trip), the
// resulting* FK set-null behavior, and the noteId cascade.
// ──────────────────────────────────────────────────────────────────

describe("triage_decisions schema (T2 P1)", () => {
  let db: AppDatabase;
  let userId: string;
  let projectId: string;
  let noteId: string;

  beforeEach(() => {
    db = setupDb();
    const workspaceId = db.select().from(workspaces).all()[0].id;
    const ts = now();

    userId = createId();
    db.insert(users)
      .values({
        id: userId,
        username: "triager",
        displayName: "Triager",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    projectId = createId();
    db.insert(projects)
      .values({
        id: projectId,
        workspaceId,
        name: "Triage Project",
        slug: "triage-project",
        createdAt: ts,
        updatedAt: ts,
        createdBy: userId,
      })
      .run();

    noteId = createId();
    db.insert(notes)
      .values({
        id: noteId,
        projectId,
        kind: "bug",
        status: "open",
        title: "a note to triage",
        authorId: userId,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
  });

  afterEach(() => {
    closeDb();
  });

  it("creates the table with its 2 indexes", () => {
    const idx = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='triage_decisions'`,
    );
    const names = (idx as any[]).map((r: any) => r.name);
    expect(names).toContain("idx_triage_decisions_project_created");
    expect(names).toContain("idx_triage_decisions_note");
  });

  it("inserts all columns and re-selects them deep-equal", () => {
    const ts = now();
    const proposalId = createId();
    db.insert(proposals)
      .values({
        id: proposalId,
        projectId,
        title: "minted proposal",
        status: "open",
        createdBy: userId,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    const id = createId();
    const row = {
      id,
      projectId,
      noteId,
      mode: "on" as const,
      decision: "promote_standard" as const,
      rationale: "looks promotable",
      confidence: 0.77,
      resultingProposalId: proposalId,
      resultingTaskId: null,
      actorId: userId,
      createdAt: ts,
    };
    db.insert(triageDecisions).values(row).run();

    const reread = db.select().from(triageDecisions).where(eq(triageDecisions.id, id)).get()!;
    expect(reread).toEqual(row);
  });

  it("SET NULL on resulting_proposal_id when the proposal is deleted (the audit row survives)", () => {
    const ts = now();
    const proposalId = createId();
    db.insert(proposals)
      .values({
        id: proposalId,
        projectId,
        title: "to be deleted",
        status: "open",
        createdBy: userId,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    const id = createId();
    db.insert(triageDecisions)
      .values({
        id,
        projectId,
        noteId,
        mode: "on",
        decision: "promote_standard",
        resultingProposalId: proposalId,
        actorId: userId,
        createdAt: ts,
      })
      .run();

    db.delete(proposals).where(eq(proposals.id, proposalId)).run();

    const reread = db.select().from(triageDecisions).where(eq(triageDecisions.id, id)).get();
    expect(reread).toBeDefined();
    expect(reread!.resultingProposalId).toBeNull();
  });

  it("SET NULL on resulting_task_id when the task is deleted (the audit row survives)", () => {
    const ts = now();
    const taskId = createId();
    db.insert(tasks)
      .values({
        id: taskId,
        projectId,
        title: "to be deleted",
        status: "backlog",
        priority: "medium",
        type: "feature",
        reporterId: userId,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    const id = createId();
    db.insert(triageDecisions)
      .values({
        id,
        projectId,
        noteId,
        mode: "on",
        decision: "promote_fast_track",
        resultingTaskId: taskId,
        actorId: userId,
        createdAt: ts,
      })
      .run();

    db.delete(tasks).where(eq(tasks.id, taskId)).run();

    const reread = db.select().from(triageDecisions).where(eq(triageDecisions.id, id)).get();
    expect(reread).toBeDefined();
    expect(reread!.resultingTaskId).toBeNull();
  });

  it("CASCADE: deleting a note deletes its triage decisions", () => {
    const ts = now();
    const id = createId();
    db.insert(triageDecisions)
      .values({
        id,
        projectId,
        noteId,
        mode: "shadow",
        decision: "dismiss",
        actorId: userId,
        createdAt: ts,
      })
      .run();

    db.delete(notes).where(eq(notes.id, noteId)).run();

    const reread = db.select().from(triageDecisions).where(eq(triageDecisions.id, id)).get();
    expect(reread).toBeUndefined();
  });

  it("rejects a row with a nonexistent note_id (FK enforced)", () => {
    const ts = now();
    expect(() => {
      db.insert(triageDecisions)
        .values({
          id: createId(),
          projectId,
          noteId: "nonexistent",
          mode: "shadow",
          decision: "dismiss",
          actorId: userId,
          createdAt: ts,
        })
        .run();
    }).toThrow();
  });
});
