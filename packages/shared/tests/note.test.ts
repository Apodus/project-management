import { describe, it, expect } from "vitest";
import {
  NOTE_KINDS,
  NOTE_STATUSES,
  NOTE_MUTABLE_STATUSES,
  NOTE_TERMINAL_STATUSES,
  NOTE_REOPENABLE_STATUSES,
  isMutableNoteStatus,
  isReopenableNoteStatus,
  NOTE_ANCHOR_TYPES,
  NOTE_SEVERITIES,
  NOTE_TRIAGE_OUTCOMES,
  codeLocatorSchema,
  noteSchema,
  createNoteSchema,
  patchNoteSchema,
} from "../src/index.js";

const VALID_ULID = "01H5K3RCH3EABY3V5SXGM7N1WQ";
const VALID_TIMESTAMP = "2026-05-30T12:00:00.000Z";

// ─── Enum constants ───────────────────────────────────────────────

describe("note enums", () => {
  it("NOTE_KINDS is the canonical ordered tuple", () => {
    expect([...NOTE_KINDS]).toEqual(["bug", "question", "idea", "tech_debt", "wtf", "observation"]);
  });

  it("NOTE_STATUSES is the 3-lane machine open/needs_human/triaged (no triage-outcome leak)", () => {
    expect([...NOTE_STATUSES]).toEqual(["open", "needs_human", "triaged"]);
  });

  it("status partitions are coherent: mutable ∪ terminal = all, and they are disjoint", () => {
    const mutable = [...NOTE_MUTABLE_STATUSES];
    const terminal = [...NOTE_TERMINAL_STATUSES];
    // Union (set-equality, order-independent) = every status.
    expect(new Set([...mutable, ...terminal])).toEqual(new Set(NOTE_STATUSES));
    // Disjoint — no status is both mutable and terminal.
    expect(mutable.filter((s) => (terminal as string[]).includes(s))).toEqual([]);
  });

  it("needs_human is mutable AND reopenable", () => {
    expect(isMutableNoteStatus("needs_human")).toBe(true);
    expect(isReopenableNoteStatus("needs_human")).toBe(true);
    expect(NOTE_REOPENABLE_STATUSES as readonly string[]).toContain("needs_human");
  });

  it("triaged is terminal (NOT mutable) AND reopenable", () => {
    expect(isMutableNoteStatus("triaged")).toBe(false);
    expect(isReopenableNoteStatus("triaged")).toBe(true);
    expect(NOTE_TERMINAL_STATUSES as readonly string[]).toContain("triaged");
  });

  it("open is mutable but NOT reopenable (already open)", () => {
    expect(isMutableNoteStatus("open")).toBe(true);
    expect(isReopenableNoteStatus("open")).toBe(false);
    expect(NOTE_REOPENABLE_STATUSES as readonly string[]).not.toContain("open");
  });

  it("NOTE_ANCHOR_TYPES is the canonical ordered tuple and has NO 'none' value", () => {
    expect([...NOTE_ANCHOR_TYPES]).toEqual(["task", "epic", "proposal"]);
    expect(NOTE_ANCHOR_TYPES as readonly string[]).not.toContain("none");
  });

  it("NOTE_SEVERITIES is the canonical ordered tuple", () => {
    expect([...NOTE_SEVERITIES]).toEqual(["low", "medium", "high"]);
  });

  it("NOTE_TRIAGE_OUTCOMES is the canonical ordered tuple (Campaign C2)", () => {
    expect([...NOTE_TRIAGE_OUTCOMES]).toEqual(["promoted", "dismissed"]);
  });
});

// ─── codeLocatorSchema ────────────────────────────────────────────

describe("codeLocatorSchema", () => {
  it("accepts a path-only locator", () => {
    expect(codeLocatorSchema.parse({ path: "src/foo.ts" })).toEqual({ path: "src/foo.ts" });
  });

  it("accepts a full locator with line and commitSha", () => {
    const full = { path: "src/foo.ts", line: 42, commitSha: "abc123" };
    expect(codeLocatorSchema.parse(full)).toEqual(full);
  });

  it("rejects a missing path", () => {
    expect(() => codeLocatorSchema.parse({ line: 1 })).toThrow();
  });

  it("rejects a non-positive line", () => {
    expect(() => codeLocatorSchema.parse({ path: "src/foo.ts", line: 0 })).toThrow();
    expect(() => codeLocatorSchema.parse({ path: "src/foo.ts", line: -1 })).toThrow();
  });
});

// ─── noteSchema ───────────────────────────────────────────────────

describe("noteSchema", () => {
  const validRow = {
    id: VALID_ULID,
    projectId: VALID_ULID,
    kind: "bug" as const,
    status: "open" as const,
    title: "Crash on startup",
    body: "Stack trace ...",
    anchorType: "task" as const,
    anchorId: VALID_ULID,
    codeLocator: { path: "src/app.ts", line: 10 },
    severity: "high" as const,
    authorId: VALID_ULID,
    createdAt: VALID_TIMESTAMP,
    updatedAt: VALID_TIMESTAMP,
    // Campaign C2 triage fields — null on an untriaged (open) note.
    triagedAt: null,
    triagedBy: null,
    triageOutcome: null,
    triageReason: null,
    promotedProposalId: null,
    promotedTaskId: null,
  };

  it("accepts a full valid row", () => {
    expect(noteSchema.parse(validRow)).toEqual(validRow);
  });

  it("accepts null body/anchorType/anchorId/codeLocator/severity", () => {
    const nulled = {
      ...validRow,
      body: null,
      anchorType: null,
      anchorId: null,
      codeLocator: null,
      severity: null,
    };
    expect(noteSchema.parse(nulled)).toEqual(nulled);
  });

  it("rejects a missing title", () => {
    const { title: _title, ...withoutTitle } = validRow;
    expect(() => noteSchema.parse(withoutTitle)).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() => noteSchema.parse({ ...validRow, title: "" })).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => noteSchema.parse({ ...validRow, kind: "feature" })).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() => noteSchema.parse({ ...validRow, status: "promoted" })).toThrow();
  });

  it("rejects an unknown anchorType", () => {
    expect(() => noteSchema.parse({ ...validRow, anchorType: "none" })).toThrow();
  });

  it("rejects an unknown severity", () => {
    expect(() => noteSchema.parse({ ...validRow, severity: "critical" })).toThrow();
  });

  // ── Triage read-shape (Campaign C2) ──────────────────────────────
  it("parses a triaged/promoted row with triage metadata populated", () => {
    const promoted = {
      ...validRow,
      status: "triaged" as const,
      triagedAt: VALID_TIMESTAMP,
      triagedBy: VALID_ULID,
      triageOutcome: "promoted" as const,
      triageReason: "Real bug — worth a task",
      promotedProposalId: VALID_ULID,
      promotedTaskId: null,
    };
    expect(noteSchema.parse(promoted)).toEqual(promoted);
  });

  it("rejects an unknown triageOutcome value", () => {
    expect(() => noteSchema.parse({ ...validRow, triageOutcome: "archived" })).toThrow();
  });
});

// ─── createNoteSchema ─────────────────────────────────────────────

describe("createNoteSchema", () => {
  it("accepts a minimal { kind, title }", () => {
    expect(createNoteSchema.parse({ kind: "idea", title: "Try X" })).toEqual({
      kind: "idea",
      title: "Try X",
    });
  });

  it("rejects a missing title", () => {
    expect(() => createNoteSchema.parse({ kind: "idea" })).toThrow();
  });

  it("strips an unknown status key", () => {
    const parsed = createNoteSchema.parse({ kind: "idea", title: "Try X", status: "triaged" });
    expect(parsed).not.toHaveProperty("status");
  });

  it("ignores a triageOutcome key (triage is server-driven)", () => {
    const parsed = createNoteSchema.parse({
      kind: "idea",
      title: "Try X",
      triageOutcome: "promoted",
    });
    expect(parsed).not.toHaveProperty("triageOutcome");
  });
});

// ─── patchNoteSchema ──────────────────────────────────────────────

describe("patchNoteSchema", () => {
  it("accepts an empty patch", () => {
    expect(patchNoteSchema.parse({})).toEqual({});
  });

  it("accepts a title-only patch", () => {
    expect(patchNoteSchema.parse({ title: "x" })).toEqual({ title: "x" });
  });

  it("does NOT surface a status field (status is read-only in C1)", () => {
    const parsed = patchNoteSchema.parse({ status: "triaged" });
    expect(parsed).not.toHaveProperty("status");
  });

  it("rejects an explicit empty title", () => {
    expect(() => patchNoteSchema.parse({ title: "" })).toThrow();
  });

  it("ignores a triageOutcome key (triage is server-driven)", () => {
    const parsed = patchNoteSchema.parse({ triageOutcome: "dismissed" });
    expect(parsed).not.toHaveProperty("triageOutcome");
  });
});
