import { describe, it, expect } from "vitest";
import {
  ulidSchema,
  timestampSchema,
  optionalText,
  selectWorkspaceSchema,
  insertWorkspaceSchema,
  selectUserSchema,
  insertUserSchema,
  selectProjectSchema,
  insertProjectSchema,
  projectSettingsSchema,
  aiAutonomySettingsSchema,
  workflowSettingsSchema,
  gitSettingsSchema,
  selectProposalSchema,
  insertProposalSchema,
  selectEpicSchema,
  insertEpicSchema,
  selectTaskSchema,
  insertTaskSchema,
  taskContextSchema,
  selectCommentSchema,
  insertCommentSchema,
  progressUpdateMetadataSchema,
  decisionMetadataSchema,
  handoffMetadataSchema,
  selectLabelSchema,
  insertLabelSchema,
  taskLabelSchema,
  selectTaskDependencySchema,
  insertTaskDependencySchema,
  selectActivityLogSchema,
  insertActivityLogSchema,
  selectGitRefSchema,
  insertGitRefSchema,
  selectMilestoneSchema,
  insertMilestoneSchema,
} from "../src/index.js";

// ============================================================
// Helpers
// ============================================================

// A valid ULID for testing (26 chars, Crockford Base32)
const VALID_ULID = "01H5K3RCH3EABY3V5SXGM7N1WQ";
const VALID_ULID_LOWER = "01h5k3rch3eaby3v5sxgm7n1wq";
const VALID_TIMESTAMP = "2026-05-27T12:00:00.000Z";

// ============================================================
// Common schemas
// ============================================================

describe("ulidSchema", () => {
  it("accepts a valid uppercase ULID", () => {
    expect(ulidSchema.parse(VALID_ULID)).toBe(VALID_ULID);
  });

  it("accepts a valid lowercase ULID", () => {
    expect(ulidSchema.parse(VALID_ULID_LOWER)).toBe(VALID_ULID_LOWER);
  });

  it("accepts a mixed-case ULID", () => {
    expect(ulidSchema.parse("01H5k3RcH3eAbY3v5SxGm7N1Wq")).toBeTruthy();
  });

  it("rejects a ULID that is too short", () => {
    expect(() => ulidSchema.parse("01H5K3RCH3EABY3V5SXGM")).toThrow();
  });

  it("rejects a ULID that is too long", () => {
    expect(() => ulidSchema.parse("01H5K3RCH3EABY3V5SXGM7N1WQ0")).toThrow();
  });

  it("rejects a ULID with invalid characters (I, L, O, U)", () => {
    // I is not valid in Crockford Base32
    expect(() => ulidSchema.parse("01H5K3RCH3EABY3V5SXGI7N1WQ")).toThrow();
    // L is not valid
    expect(() => ulidSchema.parse("01H5K3RCH3EABY3V5SXGL7N1WQ")).toThrow();
    // O is not valid
    expect(() => ulidSchema.parse("01H5K3RCH3EABY3V5SXGO7N1WQ")).toThrow();
    // U is not valid
    expect(() => ulidSchema.parse("01H5K3RCH3EABY3V5SXGU7N1WQ")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => ulidSchema.parse("")).toThrow();
  });

  it("rejects non-string types", () => {
    expect(() => ulidSchema.parse(123)).toThrow();
    expect(() => ulidSchema.parse(null)).toThrow();
  });
});

describe("timestampSchema", () => {
  it("accepts a valid ISO 8601 timestamp", () => {
    expect(timestampSchema.parse(VALID_TIMESTAMP)).toBe(VALID_TIMESTAMP);
  });

  it("accepts ISO 8601 without milliseconds", () => {
    expect(timestampSchema.parse("2026-05-27T12:00:00Z")).toBeTruthy();
  });

  it("rejects invalid timestamp strings", () => {
    expect(() => timestampSchema.parse("not-a-date")).toThrow();
    expect(() => timestampSchema.parse("2026-05-27")).toThrow();
    expect(() => timestampSchema.parse("")).toThrow();
  });

  it("rejects non-string types", () => {
    expect(() => timestampSchema.parse(Date.now())).toThrow();
  });
});

describe("optionalText", () => {
  it("accepts a regular string", () => {
    expect(optionalText.parse("hello")).toBe("hello");
  });

  it("trims whitespace", () => {
    expect(optionalText.parse("  hello  ")).toBe("hello");
  });

  it("accepts null", () => {
    expect(optionalText.parse(null)).toBeNull();
  });

  it("accepts undefined", () => {
    expect(optionalText.parse(undefined)).toBeUndefined();
  });
});

// ============================================================
// Workspace
// ============================================================

describe("selectWorkspaceSchema", () => {
  const validWorkspace = {
    id: VALID_ULID,
    name: "My Workspace",
    description: "A workspace",
    settings: null,
    created_at: VALID_TIMESTAMP,
    updated_at: VALID_TIMESTAMP,
  };

  it("accepts a valid workspace", () => {
    expect(selectWorkspaceSchema.parse(validWorkspace)).toEqual(validWorkspace);
  });

  it("accepts workspace with null description", () => {
    const ws = { ...validWorkspace, description: null };
    expect(selectWorkspaceSchema.parse(ws).description).toBeNull();
  });

  it("rejects workspace missing name", () => {
    const { name: _, ...ws } = validWorkspace;
    expect(() => selectWorkspaceSchema.parse(ws)).toThrow();
  });

  it("rejects workspace with empty name", () => {
    expect(() => selectWorkspaceSchema.parse({ ...validWorkspace, name: "" })).toThrow();
  });

  it("rejects workspace with invalid id", () => {
    expect(() => selectWorkspaceSchema.parse({ ...validWorkspace, id: "bad" })).toThrow();
  });
});

describe("insertWorkspaceSchema", () => {
  it("accepts valid insert data (no id, no timestamps)", () => {
    const data = { name: "WS", description: null, settings: null };
    expect(insertWorkspaceSchema.parse(data)).toEqual(data);
  });

  it("rejects if id is provided", () => {
    const data = { id: VALID_ULID, name: "WS", description: null, settings: null };
    const parsed = insertWorkspaceSchema.parse(data);
    expect(parsed).not.toHaveProperty("id");
  });
});

// ============================================================
// User
// ============================================================

describe("selectUserSchema", () => {
  const validUser = {
    id: VALID_ULID,
    username: "alice",
    display_name: "Alice",
    email: "alice@example.com",
    role: "admin" as const,
    type: "human" as const,
    avatar_url: null,
    password_hash: "hashed",
    api_token_hash: null,
    is_active: true,
    created_at: VALID_TIMESTAMP,
    updated_at: VALID_TIMESTAMP,
  };

  it("accepts a valid human user", () => {
    expect(selectUserSchema.parse(validUser)).toEqual(validUser);
  });

  it("accepts a valid AI agent user", () => {
    const aiUser = {
      ...validUser,
      type: "ai_agent" as const,
      role: "member" as const,
      password_hash: null,
    };
    expect(selectUserSchema.parse(aiUser)).toEqual(aiUser);
  });

  it("rejects invalid role", () => {
    expect(() => selectUserSchema.parse({ ...validUser, role: "superadmin" })).toThrow();
  });

  it("rejects invalid type", () => {
    expect(() => selectUserSchema.parse({ ...validUser, type: "bot" })).toThrow();
  });

  it("rejects missing username", () => {
    const { username: _, ...user } = validUser;
    expect(() => selectUserSchema.parse(user)).toThrow();
  });

  it("rejects empty display_name", () => {
    expect(() => selectUserSchema.parse({ ...validUser, display_name: "" })).toThrow();
  });
});

describe("insertUserSchema", () => {
  it("accepts valid insert data", () => {
    const data = {
      username: "bob",
      display_name: "Bob",
      email: null,
      role: "member" as const,
      type: "human" as const,
      avatar_url: null,
      password_hash: "hash",
      api_token_hash: null,
      is_active: true,
    };
    expect(insertUserSchema.parse(data)).toEqual(data);
  });
});

// ============================================================
// Project
// ============================================================

describe("selectProjectSchema", () => {
  const validProject = {
    id: VALID_ULID,
    workspace_id: VALID_ULID,
    name: "My Project",
    slug: "my-project",
    description: "A project",
    status: "active" as const,
    git_repo_url: null,
    settings: null,
    sort_order: 0,
    created_at: VALID_TIMESTAMP,
    updated_at: VALID_TIMESTAMP,
    created_by: VALID_ULID,
  };

  it("accepts a valid project", () => {
    expect(selectProjectSchema.parse(validProject)).toEqual(validProject);
  });

  it("accepts all valid project statuses", () => {
    for (const status of ["active", "paused", "archived", "completed"]) {
      expect(selectProjectSchema.parse({ ...validProject, status })).toBeTruthy();
    }
  });

  it("rejects invalid status", () => {
    expect(() => selectProjectSchema.parse({ ...validProject, status: "deleted" })).toThrow();
  });

  it("rejects missing name", () => {
    const { name: _, ...p } = validProject;
    expect(() => selectProjectSchema.parse(p)).toThrow();
  });

  it("rejects missing workspace_id", () => {
    const { workspace_id: _, ...p } = validProject;
    expect(() => selectProjectSchema.parse(p)).toThrow();
  });

  it("rejects invalid created_by (not ULID)", () => {
    expect(() =>
      selectProjectSchema.parse({ ...validProject, created_by: "not-a-ulid" }),
    ).toThrow();
  });
});

describe("insertProjectSchema", () => {
  it("accepts valid insert data", () => {
    const data = {
      workspace_id: VALID_ULID,
      name: "New Project",
      slug: "new-project",
      description: null,
      status: "active" as const,
      git_repo_url: null,
      settings: null,
      sort_order: 1,
      created_by: VALID_ULID,
    };
    expect(insertProjectSchema.parse(data)).toEqual(data);
  });
});

describe("projectSettingsSchema", () => {
  const validSettings = {
    ai_autonomy: {
      can_self_assign: true,
      can_create_subtasks: true,
      can_create_tasks: false,
      can_change_priority: false,
      can_close_epics: false,
      max_concurrent_tasks: 3,
    },
    workflow: {
      statuses: ["backlog", "ready", "in_progress", "in_review", "done", "cancelled"] as const,
    },
    git: {
      branch_prefix: "feat/",
      auto_link_branches: true,
    },
  };

  it("accepts a valid full settings object", () => {
    expect(projectSettingsSchema.parse(validSettings)).toEqual(validSettings);
  });

  it("accepts null settings", () => {
    expect(projectSettingsSchema.parse(null)).toBeNull();
  });

  it("accepts undefined settings", () => {
    expect(projectSettingsSchema.parse(undefined)).toBeUndefined();
  });
});

describe("aiAutonomySettingsSchema", () => {
  it("rejects max_concurrent_tasks less than 1", () => {
    expect(() =>
      aiAutonomySettingsSchema.parse({
        can_self_assign: true,
        can_create_subtasks: true,
        can_create_tasks: false,
        can_change_priority: false,
        can_close_epics: false,
        max_concurrent_tasks: 0,
      }),
    ).toThrow();
  });

  it("rejects non-integer max_concurrent_tasks", () => {
    expect(() =>
      aiAutonomySettingsSchema.parse({
        can_self_assign: true,
        can_create_subtasks: true,
        can_create_tasks: false,
        can_change_priority: false,
        can_close_epics: false,
        max_concurrent_tasks: 2.5,
      }),
    ).toThrow();
  });
});

describe("workflowSettingsSchema", () => {
  it("rejects invalid statuses", () => {
    expect(() => workflowSettingsSchema.parse({ statuses: ["invalid_status"] })).toThrow();
  });
});

describe("gitSettingsSchema", () => {
  it("accepts valid git settings", () => {
    expect(
      gitSettingsSchema.parse({ branch_prefix: "feat/", auto_link_branches: true }),
    ).toBeTruthy();
  });
});

// ============================================================
// Proposal
// ============================================================

describe("selectProposalSchema", () => {
  const validProposal = {
    id: VALID_ULID,
    project_id: VALID_ULID,
    title: "Add user auth",
    description: "We need authentication",
    status: "open" as const,
    created_by: VALID_ULID,
    resolved_by: null,
    resolved_at: null,
    created_at: VALID_TIMESTAMP,
    updated_at: VALID_TIMESTAMP,
  };

  it("accepts a valid proposal", () => {
    expect(selectProposalSchema.parse(validProposal)).toEqual(validProposal);
  });

  it("accepts all valid proposal statuses", () => {
    for (const status of ["open", "discussing", "accepted", "planned", "in_progress", "completed", "rejected"]) {
      expect(selectProposalSchema.parse({ ...validProposal, status })).toBeTruthy();
    }
  });

  it("allows nullable project_id", () => {
    const p = { ...validProposal, project_id: null };
    expect(selectProposalSchema.parse(p).project_id).toBeNull();
  });

  it("rejects invalid status", () => {
    expect(() => selectProposalSchema.parse({ ...validProposal, status: "draft" })).toThrow();
  });

  it("rejects missing title", () => {
    const { title: _, ...p } = validProposal;
    expect(() => selectProposalSchema.parse(p)).toThrow();
  });

  it("rejects empty title", () => {
    expect(() => selectProposalSchema.parse({ ...validProposal, title: "" })).toThrow();
  });
});

describe("insertProposalSchema", () => {
  it("accepts valid insert data", () => {
    const data = {
      project_id: VALID_ULID,
      title: "New feature idea",
      description: "Some description",
      status: "open" as const,
      created_by: VALID_ULID,
      resolved_by: null,
      resolved_at: null,
    };
    expect(insertProposalSchema.parse(data)).toEqual(data);
  });
});

// ============================================================
// Epic
// ============================================================

describe("selectEpicSchema", () => {
  const validEpic = {
    id: VALID_ULID,
    project_id: VALID_ULID,
    proposal_id: null,
    milestone_id: null,
    name: "Authentication Epic",
    description: "Implement auth",
    status: "draft" as const,
    priority: "high" as const,
    target_date: null,
    sort_order: 0,
    created_at: VALID_TIMESTAMP,
    updated_at: VALID_TIMESTAMP,
    created_by: VALID_ULID,
  };

  it("accepts a valid epic", () => {
    expect(selectEpicSchema.parse(validEpic)).toEqual(validEpic);
  });

  it("accepts all valid epic statuses", () => {
    for (const status of ["draft", "active", "completed", "cancelled"]) {
      expect(selectEpicSchema.parse({ ...validEpic, status })).toBeTruthy();
    }
  });

  it("accepts all valid priorities", () => {
    for (const priority of ["critical", "high", "medium", "low"]) {
      expect(selectEpicSchema.parse({ ...validEpic, priority })).toBeTruthy();
    }
  });

  it("rejects invalid status", () => {
    expect(() => selectEpicSchema.parse({ ...validEpic, status: "open" })).toThrow();
  });

  it("rejects invalid priority", () => {
    expect(() => selectEpicSchema.parse({ ...validEpic, priority: "urgent" })).toThrow();
  });

  it("rejects missing project_id", () => {
    const { project_id: _, ...e } = validEpic;
    expect(() => selectEpicSchema.parse(e)).toThrow();
  });
});

describe("insertEpicSchema", () => {
  it("accepts valid insert data", () => {
    const data = {
      project_id: VALID_ULID,
      proposal_id: VALID_ULID,
      milestone_id: null,
      name: "New Epic",
      description: "Details",
      status: "draft" as const,
      priority: "medium" as const,
      target_date: null,
      sort_order: 0,
      created_by: VALID_ULID,
    };
    expect(insertEpicSchema.parse(data)).toEqual(data);
  });
});

// ============================================================
// Task
// ============================================================

describe("selectTaskSchema", () => {
  const validTask = {
    id: VALID_ULID,
    project_id: VALID_ULID,
    proposal_id: null,
    epic_id: null,
    parent_task_id: null,
    title: "Implement login page",
    description: "Create the login form",
    status: "backlog" as const,
    priority: "medium" as const,
    type: "feature" as const,
    assignee_id: null,
    reporter_id: VALID_ULID,
    estimated_effort: null,
    due_date: null,
    sort_order: 0,
    context: null,
    git_branch: null,
    created_at: VALID_TIMESTAMP,
    updated_at: VALID_TIMESTAMP,
    started_at: null,
    completed_at: null,
  };

  it("accepts a valid task", () => {
    expect(selectTaskSchema.parse(validTask)).toEqual(validTask);
  });

  it("accepts all valid task statuses", () => {
    for (const status of ["backlog", "ready", "in_progress", "in_review", "done", "cancelled"]) {
      expect(selectTaskSchema.parse({ ...validTask, status })).toBeTruthy();
    }
  });

  it("accepts all valid task types", () => {
    for (const type of ["feature", "bug", "chore", "spike", "design", "research"]) {
      expect(selectTaskSchema.parse({ ...validTask, type })).toBeTruthy();
    }
  });

  it("accepts all valid effort sizes", () => {
    for (const effort of ["xs", "s", "m", "l", "xl"]) {
      expect(
        selectTaskSchema.parse({ ...validTask, estimated_effort: effort }),
      ).toBeTruthy();
    }
  });

  it("rejects invalid status", () => {
    expect(() => selectTaskSchema.parse({ ...validTask, status: "pending" })).toThrow();
  });

  it("rejects invalid type", () => {
    expect(() => selectTaskSchema.parse({ ...validTask, type: "story" })).toThrow();
  });

  it("rejects invalid effort size", () => {
    expect(() => selectTaskSchema.parse({ ...validTask, estimated_effort: "xxl" })).toThrow();
  });

  it("rejects missing title", () => {
    const { title: _, ...t } = validTask;
    expect(() => selectTaskSchema.parse(t)).toThrow();
  });

  it("rejects empty title", () => {
    expect(() => selectTaskSchema.parse({ ...validTask, title: "" })).toThrow();
  });

  it("rejects missing reporter_id", () => {
    const { reporter_id: _, ...t } = validTask;
    expect(() => selectTaskSchema.parse(t)).toThrow();
  });

  it("accepts task with context object", () => {
    const ctx = {
      relevant_files: ["src/auth.ts"],
      codebase_areas: ["auth"],
      acceptance_criteria: ["Login works"],
      design_references: ["docs/auth.md"],
      notes: "Important note",
      implementation_hints: "Use existing middleware",
    };
    expect(selectTaskSchema.parse({ ...validTask, context: ctx }).context).toEqual(ctx);
  });

  it("accepts task with timestamps for started_at and completed_at", () => {
    const t = {
      ...validTask,
      status: "done",
      started_at: VALID_TIMESTAMP,
      completed_at: VALID_TIMESTAMP,
    };
    expect(selectTaskSchema.parse(t)).toBeTruthy();
  });
});

describe("insertTaskSchema", () => {
  it("accepts valid insert data", () => {
    const data = {
      project_id: VALID_ULID,
      proposal_id: null,
      epic_id: null,
      parent_task_id: null,
      title: "New task",
      description: null,
      status: "backlog" as const,
      priority: "low" as const,
      type: "chore" as const,
      assignee_id: null,
      reporter_id: VALID_ULID,
      estimated_effort: "s" as const,
      due_date: null,
      sort_order: 0,
      context: null,
      git_branch: null,
      started_at: null,
      completed_at: null,
    };
    expect(insertTaskSchema.parse(data)).toEqual(data);
  });
});

describe("taskContextSchema", () => {
  it("accepts a full context object", () => {
    const ctx = {
      relevant_files: ["src/foo.ts", "src/bar.ts"],
      codebase_areas: ["authentication", "middleware"],
      acceptance_criteria: ["All endpoints require token", "Expired tokens return 401"],
      design_references: ["docs/design/auth-design.md"],
      notes: "Must be compatible with session middleware",
      implementation_hints: "Use validateToken utility",
    };
    expect(taskContextSchema.parse(ctx)).toEqual(ctx);
  });

  it("accepts a partial context object", () => {
    expect(taskContextSchema.parse({ relevant_files: ["src/foo.ts"] })).toEqual({
      relevant_files: ["src/foo.ts"],
    });
  });

  it("accepts an empty context object", () => {
    expect(taskContextSchema.parse({})).toEqual({});
  });

  it("accepts null", () => {
    expect(taskContextSchema.parse(null)).toBeNull();
  });

  it("accepts undefined", () => {
    expect(taskContextSchema.parse(undefined)).toBeUndefined();
  });
});

// ============================================================
// Comment
// ============================================================

describe("selectCommentSchema", () => {
  const validComment = {
    id: VALID_ULID,
    task_id: VALID_ULID,
    proposal_id: null,
    author_id: VALID_ULID,
    body: "This is a comment",
    comment_type: "comment" as const,
    metadata: null,
    created_at: VALID_TIMESTAMP,
    updated_at: VALID_TIMESTAMP,
  };

  it("accepts a valid comment on a task", () => {
    expect(selectCommentSchema.parse(validComment)).toEqual(validComment);
  });

  it("accepts a valid comment on a proposal", () => {
    const c = { ...validComment, task_id: null, proposal_id: VALID_ULID };
    expect(selectCommentSchema.parse(c)).toBeTruthy();
  });

  it("accepts all valid comment types", () => {
    for (const ct of [
      "comment",
      "progress_update",
      "decision",
      "question",
      "handoff",
      "review_note",
      "design_discussion",
    ]) {
      expect(selectCommentSchema.parse({ ...validComment, comment_type: ct })).toBeTruthy();
    }
  });

  it("rejects invalid comment_type", () => {
    expect(() =>
      selectCommentSchema.parse({ ...validComment, comment_type: "note" }),
    ).toThrow();
  });

  it("rejects empty body", () => {
    expect(() => selectCommentSchema.parse({ ...validComment, body: "" })).toThrow();
  });

  it("rejects missing author_id", () => {
    const { author_id: _, ...c } = validComment;
    expect(() => selectCommentSchema.parse(c)).toThrow();
  });
});

describe("insertCommentSchema", () => {
  it("accepts valid insert data", () => {
    const data = {
      task_id: VALID_ULID,
      proposal_id: null,
      author_id: VALID_ULID,
      body: "Comment body",
      comment_type: "comment" as const,
      metadata: null,
    };
    expect(insertCommentSchema.parse(data)).toEqual(data);
  });
});

describe("progressUpdateMetadataSchema", () => {
  it("accepts valid progress update", () => {
    const meta = {
      completion_pct: 60,
      files_changed: ["src/foo.ts"],
      summary: "Made progress",
    };
    expect(progressUpdateMetadataSchema.parse(meta)).toEqual(meta);
  });

  it("rejects completion_pct > 100", () => {
    expect(() =>
      progressUpdateMetadataSchema.parse({ completion_pct: 101 }),
    ).toThrow();
  });

  it("rejects completion_pct < 0", () => {
    expect(() =>
      progressUpdateMetadataSchema.parse({ completion_pct: -1 }),
    ).toThrow();
  });

  it("accepts progress update with only completion_pct", () => {
    expect(progressUpdateMetadataSchema.parse({ completion_pct: 50 })).toEqual({
      completion_pct: 50,
    });
  });
});

describe("decisionMetadataSchema", () => {
  it("accepts valid decision metadata", () => {
    const meta = {
      decision: "Use JWT over session tokens",
      rationale: "Simpler for API auth",
      alternatives_considered: ["session tokens", "OAuth"],
    };
    expect(decisionMetadataSchema.parse(meta)).toEqual(meta);
  });

  it("rejects missing decision", () => {
    expect(() =>
      decisionMetadataSchema.parse({ rationale: "Because" }),
    ).toThrow();
  });

  it("rejects missing rationale", () => {
    expect(() =>
      decisionMetadataSchema.parse({ decision: "Use X" }),
    ).toThrow();
  });

  it("accepts decision without alternatives", () => {
    const meta = { decision: "Use X", rationale: "Because Y" };
    expect(decisionMetadataSchema.parse(meta)).toEqual(meta);
  });
});

describe("handoffMetadataSchema", () => {
  it("accepts valid handoff metadata", () => {
    const meta = {
      summary: "Completed auth implementation",
      files_changed: ["src/auth.ts"],
      open_questions: ["Should we cache tokens?"],
      test_results: "all passing",
    };
    expect(handoffMetadataSchema.parse(meta)).toEqual(meta);
  });

  it("rejects missing summary", () => {
    expect(() =>
      handoffMetadataSchema.parse({ files_changed: ["file.ts"] }),
    ).toThrow();
  });

  it("accepts handoff with only summary", () => {
    const meta = { summary: "Done" };
    expect(handoffMetadataSchema.parse(meta)).toEqual(meta);
  });
});

// ============================================================
// Label
// ============================================================

describe("selectLabelSchema", () => {
  const validLabel = {
    id: VALID_ULID,
    project_id: VALID_ULID,
    name: "bug",
    color: "#FF0000",
    description: null,
  };

  it("accepts a valid label", () => {
    expect(selectLabelSchema.parse(validLabel)).toEqual(validLabel);
  });

  it("accepts lowercase hex color", () => {
    expect(selectLabelSchema.parse({ ...validLabel, color: "#ff00aa" })).toBeTruthy();
  });

  it("rejects invalid hex color (no hash)", () => {
    expect(() => selectLabelSchema.parse({ ...validLabel, color: "FF0000" })).toThrow();
  });

  it("rejects invalid hex color (3-char shorthand)", () => {
    expect(() => selectLabelSchema.parse({ ...validLabel, color: "#F00" })).toThrow();
  });

  it("rejects invalid hex color (8-char with alpha)", () => {
    expect(() => selectLabelSchema.parse({ ...validLabel, color: "#FF0000FF" })).toThrow();
  });

  it("rejects empty name", () => {
    expect(() => selectLabelSchema.parse({ ...validLabel, name: "" })).toThrow();
  });
});

describe("insertLabelSchema", () => {
  it("accepts valid insert data (no id, labels have no timestamps)", () => {
    const data = {
      project_id: VALID_ULID,
      name: "feature",
      color: "#00FF00",
      description: "Feature label",
    };
    expect(insertLabelSchema.parse(data)).toEqual(data);
  });
});

// ============================================================
// Task Label (join table)
// ============================================================

describe("taskLabelSchema", () => {
  it("accepts valid task-label pair", () => {
    const data = { task_id: VALID_ULID, label_id: VALID_ULID };
    expect(taskLabelSchema.parse(data)).toEqual(data);
  });

  it("rejects missing task_id", () => {
    expect(() => taskLabelSchema.parse({ label_id: VALID_ULID })).toThrow();
  });

  it("rejects missing label_id", () => {
    expect(() => taskLabelSchema.parse({ task_id: VALID_ULID })).toThrow();
  });

  it("rejects invalid ULIDs", () => {
    expect(() => taskLabelSchema.parse({ task_id: "bad", label_id: VALID_ULID })).toThrow();
  });
});

// ============================================================
// Task Dependency
// ============================================================

describe("selectTaskDependencySchema", () => {
  const validDep = {
    id: VALID_ULID,
    task_id: VALID_ULID,
    depends_on_task_id: VALID_ULID,
    dependency_type: "blocks" as const,
    created_at: VALID_TIMESTAMP,
  };

  it("accepts a valid dependency", () => {
    expect(selectTaskDependencySchema.parse(validDep)).toEqual(validDep);
  });

  it("accepts 'relates_to' dependency type", () => {
    expect(
      selectTaskDependencySchema.parse({ ...validDep, dependency_type: "relates_to" }),
    ).toBeTruthy();
  });

  it("rejects invalid dependency type", () => {
    expect(() =>
      selectTaskDependencySchema.parse({ ...validDep, dependency_type: "depends_on" }),
    ).toThrow();
  });
});

describe("insertTaskDependencySchema", () => {
  it("accepts valid insert data (no id, no timestamps)", () => {
    const data = {
      task_id: VALID_ULID,
      depends_on_task_id: VALID_ULID,
      dependency_type: "blocks" as const,
    };
    expect(insertTaskDependencySchema.parse(data)).toEqual(data);
  });
});

// ============================================================
// Activity Log
// ============================================================

describe("selectActivityLogSchema", () => {
  const validLog = {
    id: VALID_ULID,
    entity_type: "task" as const,
    entity_id: VALID_ULID,
    project_id: VALID_ULID,
    actor_id: VALID_ULID,
    action: "created" as const,
    changes: null,
    created_at: VALID_TIMESTAMP,
  };

  it("accepts a valid activity log", () => {
    expect(selectActivityLogSchema.parse(validLog)).toEqual(validLog);
  });

  it("accepts all valid entity types", () => {
    for (const et of ["project", "proposal", "epic", "task", "comment"]) {
      expect(selectActivityLogSchema.parse({ ...validLog, entity_type: et })).toBeTruthy();
    }
  });

  it("accepts all valid actions", () => {
    for (const action of [
      "created",
      "updated",
      "status_changed",
      "assigned",
      "commented",
      "dependency_added",
      "dependency_removed",
      "label_added",
      "label_removed",
      "archived",
    ]) {
      expect(selectActivityLogSchema.parse({ ...validLog, action })).toBeTruthy();
    }
  });

  it("accepts activity log with changes", () => {
    const log = {
      ...validLog,
      action: "status_changed" as const,
      changes: {
        status: { from: "ready", to: "in_progress" },
      },
    };
    expect(selectActivityLogSchema.parse(log).changes).toEqual({
      status: { from: "ready", to: "in_progress" },
    });
  });

  it("rejects invalid entity_type", () => {
    expect(() =>
      selectActivityLogSchema.parse({ ...validLog, entity_type: "label" }),
    ).toThrow();
  });

  it("rejects invalid action", () => {
    expect(() =>
      selectActivityLogSchema.parse({ ...validLog, action: "deleted" }),
    ).toThrow();
  });
});

describe("insertActivityLogSchema", () => {
  it("accepts valid insert data", () => {
    const data = {
      entity_type: "task" as const,
      entity_id: VALID_ULID,
      project_id: VALID_ULID,
      actor_id: VALID_ULID,
      action: "created" as const,
      changes: null,
    };
    expect(insertActivityLogSchema.parse(data)).toEqual(data);
  });
});

// ============================================================
// Git Ref
// ============================================================

describe("selectGitRefSchema", () => {
  const validGitRef = {
    id: VALID_ULID,
    task_id: VALID_ULID,
    ref_type: "branch" as const,
    ref_value: "feat/add-auth",
    url: null,
    title: null,
    status: null,
    metadata: null,
    created_at: VALID_TIMESTAMP,
  };

  it("accepts a valid branch ref", () => {
    expect(selectGitRefSchema.parse(validGitRef)).toEqual(validGitRef);
  });

  it("accepts a commit ref", () => {
    const ref = {
      ...validGitRef,
      ref_type: "commit" as const,
      ref_value: "abc123def456",
    };
    expect(selectGitRefSchema.parse(ref)).toBeTruthy();
  });

  it("accepts a pull_request ref with status", () => {
    const ref = {
      ...validGitRef,
      ref_type: "pull_request" as const,
      ref_value: "42",
      url: "https://github.com/org/repo/pull/42",
      title: "Add auth",
      status: "open" as const,
    };
    expect(selectGitRefSchema.parse(ref)).toBeTruthy();
  });

  it("accepts all valid ref types", () => {
    for (const rt of ["branch", "commit", "pull_request"]) {
      expect(selectGitRefSchema.parse({ ...validGitRef, ref_type: rt })).toBeTruthy();
    }
  });

  it("accepts all valid git ref statuses", () => {
    for (const s of ["open", "merged", "closed"]) {
      expect(selectGitRefSchema.parse({ ...validGitRef, status: s })).toBeTruthy();
    }
  });

  it("rejects invalid ref_type", () => {
    expect(() =>
      selectGitRefSchema.parse({ ...validGitRef, ref_type: "tag" }),
    ).toThrow();
  });

  it("rejects invalid status", () => {
    expect(() =>
      selectGitRefSchema.parse({ ...validGitRef, status: "draft" }),
    ).toThrow();
  });

  it("rejects empty ref_value", () => {
    expect(() =>
      selectGitRefSchema.parse({ ...validGitRef, ref_value: "" }),
    ).toThrow();
  });
});

describe("insertGitRefSchema", () => {
  it("accepts valid insert data", () => {
    const data = {
      task_id: VALID_ULID,
      ref_type: "branch" as const,
      ref_value: "feat/my-feature",
      url: null,
      title: null,
      status: null,
      metadata: null,
    };
    expect(insertGitRefSchema.parse(data)).toEqual(data);
  });
});

// ============================================================
// Milestone
// ============================================================

describe("selectMilestoneSchema", () => {
  const validMilestone = {
    id: VALID_ULID,
    project_id: VALID_ULID,
    name: "v1.0",
    description: "First release",
    target_date: "2026-06-15",
    status: "open" as const,
    sort_order: 0,
    created_at: VALID_TIMESTAMP,
    updated_at: VALID_TIMESTAMP,
  };

  it("accepts a valid milestone", () => {
    expect(selectMilestoneSchema.parse(validMilestone)).toEqual(validMilestone);
  });

  it("accepts all valid milestone statuses", () => {
    for (const s of ["open", "closed"]) {
      expect(selectMilestoneSchema.parse({ ...validMilestone, status: s })).toBeTruthy();
    }
  });

  it("accepts milestone with null target_date", () => {
    expect(
      selectMilestoneSchema.parse({ ...validMilestone, target_date: null }),
    ).toBeTruthy();
  });

  it("rejects invalid status", () => {
    expect(() =>
      selectMilestoneSchema.parse({ ...validMilestone, status: "active" }),
    ).toThrow();
  });

  it("rejects empty name", () => {
    expect(() =>
      selectMilestoneSchema.parse({ ...validMilestone, name: "" }),
    ).toThrow();
  });

  it("rejects missing project_id", () => {
    const { project_id: _, ...m } = validMilestone;
    expect(() => selectMilestoneSchema.parse(m)).toThrow();
  });
});

describe("insertMilestoneSchema", () => {
  it("accepts valid insert data", () => {
    const data = {
      project_id: VALID_ULID,
      name: "Beta",
      description: null,
      target_date: null,
      status: "open" as const,
      sort_order: 1,
    };
    expect(insertMilestoneSchema.parse(data)).toEqual(data);
  });
});
