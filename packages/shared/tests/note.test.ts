import { describe, it, expect } from "vitest";
import {
  NOTE_KINDS,
  NOTE_STATUSES,
  NOTE_ANCHOR_TYPES,
  NOTE_SEVERITIES,
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
    expect([...NOTE_KINDS]).toEqual([
      "bug",
      "question",
      "idea",
      "tech_debt",
      "wtf",
      "observation",
    ]);
  });

  it("NOTE_STATUSES is exactly open/triaged (C1 minimality — no triage-outcome leak)", () => {
    expect([...NOTE_STATUSES]).toEqual(["open", "triaged"]);
  });

  it("NOTE_ANCHOR_TYPES is the canonical ordered tuple and has NO 'none' value", () => {
    expect([...NOTE_ANCHOR_TYPES]).toEqual(["task", "epic", "proposal"]);
    expect(NOTE_ANCHOR_TYPES as readonly string[]).not.toContain("none");
  });

  it("NOTE_SEVERITIES is the canonical ordered tuple", () => {
    expect([...NOTE_SEVERITIES]).toEqual(["low", "medium", "high"]);
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
});
