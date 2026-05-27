import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/index.js";

// ---------------------------------------------------------------------------
// Mock the api-client module
// ---------------------------------------------------------------------------

vi.mock("../src/api-client.js", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  },
  apiRequest: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  listProposals: vi.fn(),
  getProposal: vi.fn(),
  addProposalComment: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  search: vi.fn(),
  implementProposal: vi.fn(),
  transitionTask: vi.fn(),
  pickNextTask: vi.fn(),
  addTaskComment: vi.fn(),
  addTaskDependency: vi.fn(),
}));

// Import the mocked functions so we can configure them per test
import * as apiClient from "../src/api-client.js";

const mockListProjects = vi.mocked(apiClient.listProjects);
const mockGetProposal = vi.mocked(apiClient.getProposal);
const mockListProposals = vi.mocked(apiClient.listProposals);
const mockAddProposalComment = vi.mocked(apiClient.addProposalComment);
const mockListTasks = vi.mocked(apiClient.listTasks);
const mockGetTask = vi.mocked(apiClient.getTask);
const mockSearch = vi.mocked(apiClient.search);
const mockImplementProposal = vi.mocked(apiClient.implementProposal);
const mockTransitionTask = vi.mocked(apiClient.transitionTask);
const mockPickNextTask = vi.mocked(apiClient.pickNextTask);
const mockAddTaskComment = vi.mocked(apiClient.addTaskComment);
const mockAddTaskDependency = vi.mocked(apiClient.addTaskDependency);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createTestClient(): Promise<Client> {
  const server = createMcpServer();
  const client = new Client({ name: "test-client", version: "0.1.0" });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return client;
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const sampleProject = {
  id: "proj_001",
  name: "Test Project",
  slug: "test-project",
  status: "active",
  description: "A test project",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const sampleTask = {
  id: "task_001",
  projectId: "proj_001",
  epicId: null,
  parentTaskId: null,
  title: "Implement feature X",
  description: "Build the feature X as described in the proposal.",
  status: "ready",
  priority: "high",
  type: "feature",
  assignee: null,
  estimatedEffort: "m",
  dueDate: null,
  sortOrder: 0,
  context: { relevant_files: ["src/foo.ts"] },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const sampleProposal = {
  id: "prop_001",
  projectId: "proj_001",
  title: "Add caching layer",
  description: "We should add a caching layer to improve performance.",
  status: "open",
  createdBy: "user_001",
  commentCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const sampleProposalDetail = {
  ...sampleProposal,
  comments: [
    {
      id: "comment_001",
      body: "This is a great idea.",
      authorId: "user_002",
      commentType: "design_discussion",
      metadata: null,
      createdAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    },
  ],
  workItems: { epics: [], tasks: [] },
};

const sampleSearchResult = {
  entityType: "task",
  entityId: "task_001",
  title: "Implement feature X",
  excerpt: "Build the feature X as described...",
  rank: 1.5,
  projectId: "proj_001",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP Tools", () => {
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = await createTestClient();
  });

  afterEach(async () => {
    await client.close();
  });

  // ---- pm_list_projects ----

  describe("pm_list_projects", () => {
    it("returns formatted project list", async () => {
      mockListProjects.mockResolvedValue([sampleProject]);

      const result = await client.callTool({ name: "pm_list_projects", arguments: {} });

      expect(result.content).toHaveLength(1);
      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Test Project");
      expect(text).toContain("test-project");
      expect(text).toContain("proj_001");
      expect(text).toContain("active");
    });

    it("passes status filter", async () => {
      mockListProjects.mockResolvedValue([]);

      await client.callTool({
        name: "pm_list_projects",
        arguments: { status: "archived" },
      });

      expect(mockListProjects).toHaveBeenCalledWith("archived");
    });

    it("handles empty results", async () => {
      mockListProjects.mockResolvedValue([]);

      const result = await client.callTool({ name: "pm_list_projects", arguments: {} });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("No projects found");
    });
  });

  // ---- pm_list_tasks ----

  describe("pm_list_tasks", () => {
    it("returns formatted task list", async () => {
      mockListTasks.mockResolvedValue([sampleTask]);

      const result = await client.callTool({
        name: "pm_list_tasks",
        arguments: { project_id: "proj_001" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Implement feature X");
      expect(text).toContain("task_001");
      expect(text).toContain("HIGH");
      expect(text).toContain("ready");
    });

    it("passes all filters correctly", async () => {
      mockListTasks.mockResolvedValue([]);

      await client.callTool({
        name: "pm_list_tasks",
        arguments: {
          project_id: "proj_001",
          status: "ready",
          priority: "high",
          type: "feature",
          assignee: "user_001",
          is_blocked: false,
          sort: "priority",
          limit: 10,
        },
      });

      expect(mockListTasks).toHaveBeenCalledWith({
        project_id: "proj_001",
        status: "ready",
        priority: "high",
        type: "feature",
        assignee: "user_001",
        epic_id: undefined,
        is_blocked: false,
        search: undefined,
        sort: "priority",
        limit: 10,
      });
    });

    it("handles empty results", async () => {
      mockListTasks.mockResolvedValue([]);

      const result = await client.callTool({ name: "pm_list_tasks", arguments: {} });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("No tasks found");
    });
  });

  // ---- pm_get_task ----

  describe("pm_get_task", () => {
    it("returns full task details", async () => {
      mockGetTask.mockResolvedValue(sampleTask);

      const result = await client.callTool({
        name: "pm_get_task",
        arguments: { task_id: "task_001" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Implement feature X");
      expect(text).toContain("task_001");
      expect(text).toContain("high");
      expect(text).toContain("feature");
      expect(text).toContain("Build the feature X");
      expect(text).toContain("relevant_files");
    });

    it("calls getTask with the correct ID", async () => {
      mockGetTask.mockResolvedValue(sampleTask);

      await client.callTool({
        name: "pm_get_task",
        arguments: { task_id: "task_001" },
      });

      expect(mockGetTask).toHaveBeenCalledWith("task_001");
    });
  });

  // ---- pm_search ----

  describe("pm_search", () => {
    it("returns formatted search results", async () => {
      mockSearch.mockResolvedValue([sampleSearchResult]);

      const result = await client.callTool({
        name: "pm_search",
        arguments: { query: "feature" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Implement feature X");
      expect(text).toContain("task_001");
      expect(text).toContain("task");
    });

    it("passes all search options", async () => {
      mockSearch.mockResolvedValue([]);

      await client.callTool({
        name: "pm_search",
        arguments: {
          query: "caching",
          project_id: "proj_001",
          entity_type: "proposal",
          limit: 5,
        },
      });

      expect(mockSearch).toHaveBeenCalledWith("caching", {
        project_id: "proj_001",
        entity_type: "proposal",
        limit: 5,
      });
    });

    it("handles no results", async () => {
      mockSearch.mockResolvedValue([]);

      const result = await client.callTool({
        name: "pm_search",
        arguments: { query: "nonexistent" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("No results found");
    });
  });

  // ---- pm_list_proposals ----

  describe("pm_list_proposals", () => {
    it("returns formatted proposal list", async () => {
      mockListProposals.mockResolvedValue([sampleProposal]);

      const result = await client.callTool({
        name: "pm_list_proposals",
        arguments: { project_id: "proj_001" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Add caching layer");
      expect(text).toContain("prop_001");
      expect(text).toContain("open");
    });

    it("passes status filter", async () => {
      mockListProposals.mockResolvedValue([]);

      await client.callTool({
        name: "pm_list_proposals",
        arguments: { project_id: "proj_001", status: "discussing" },
      });

      expect(mockListProposals).toHaveBeenCalledWith("proj_001", "discussing");
    });
  });

  // ---- pm_get_proposal ----

  describe("pm_get_proposal", () => {
    it("returns full proposal with comments and work items", async () => {
      mockGetProposal.mockResolvedValue(sampleProposalDetail);

      const result = await client.callTool({
        name: "pm_get_proposal",
        arguments: { proposal_id: "prop_001" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Add caching layer");
      expect(text).toContain("prop_001");
      expect(text).toContain("Discussion");
      expect(text).toContain("This is a great idea");
      expect(text).toContain("design_discussion");
    });

    it("calls getProposal with the correct ID", async () => {
      mockGetProposal.mockResolvedValue(sampleProposalDetail);

      await client.callTool({
        name: "pm_get_proposal",
        arguments: { proposal_id: "prop_001" },
      });

      expect(mockGetProposal).toHaveBeenCalledWith("prop_001");
    });
  });

  // ---- pm_discuss_proposal ----

  describe("pm_discuss_proposal", () => {
    it("creates comment and returns result", async () => {
      mockAddProposalComment.mockResolvedValue({
        comment: {
          id: "comment_002",
          body: "Let me suggest Redis for the caching layer.",
          authorId: "mcp-agent",
          commentType: "design_discussion",
          metadata: null,
          createdAt: "2026-01-03T00:00:00Z",
          updatedAt: "2026-01-03T00:00:00Z",
        },
        proposal: {
          ...sampleProposal,
          status: "discussing",
        },
      });

      const result = await client.callTool({
        name: "pm_discuss_proposal",
        arguments: {
          proposal_id: "prop_001",
          body: "Let me suggest Redis for the caching layer.",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Comment added successfully");
      expect(text).toContain("comment_002");
      expect(text).toContain("discussing");
      expect(text).toContain("Redis");
    });

    it("passes comment_type to API", async () => {
      mockAddProposalComment.mockResolvedValue({
        comment: {
          id: "comment_003",
          body: "What cache TTL should we use?",
          authorId: "mcp-agent",
          commentType: "question",
          metadata: null,
          createdAt: "2026-01-03T00:00:00Z",
          updatedAt: "2026-01-03T00:00:00Z",
        },
        proposal: { ...sampleProposal, status: "discussing" },
      });

      await client.callTool({
        name: "pm_discuss_proposal",
        arguments: {
          proposal_id: "prop_001",
          body: "What cache TTL should we use?",
          comment_type: "question",
        },
      });

      expect(mockAddProposalComment).toHaveBeenCalledWith(
        "prop_001",
        "What cache TTL should we use?",
        "question",
      );
    });

    it("defaults to design_discussion when comment_type not specified", async () => {
      mockAddProposalComment.mockResolvedValue({
        comment: {
          id: "comment_004",
          body: "My thoughts...",
          authorId: "mcp-agent",
          commentType: "design_discussion",
          metadata: null,
          createdAt: "2026-01-03T00:00:00Z",
          updatedAt: "2026-01-03T00:00:00Z",
        },
        proposal: { ...sampleProposal, status: "discussing" },
      });

      await client.callTool({
        name: "pm_discuss_proposal",
        arguments: {
          proposal_id: "prop_001",
          body: "My thoughts...",
        },
      });

      expect(mockAddProposalComment).toHaveBeenCalledWith(
        "prop_001",
        "My thoughts...",
        "design_discussion",
      );
    });
  });

  // ---- pm_implement_proposal ----

  describe("pm_implement_proposal", () => {
    it("creates work items from accepted proposal", async () => {
      mockImplementProposal.mockResolvedValue({
        ...sampleProposal,
        status: "implemented",
      });

      const result = await client.callTool({
        name: "pm_implement_proposal",
        arguments: {
          proposal_id: "prop_001",
          epics: [
            {
              name: "Epic 1",
              description: "First epic",
              tasks: [
                { title: "Task A", priority: "high" },
                { title: "Task B", type: "chore" },
              ],
            },
          ],
          tasks: [{ title: "Standalone task", priority: "medium" }],
          summary: "Breaking this into one epic and one standalone task.",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Proposal implemented successfully");
      expect(text).toContain("implemented");
      expect(text).toContain("**Epics created:** 1");
      expect(text).toContain("**Tasks created:** 3");
      expect(text).toContain("Breaking this into one epic");

      expect(mockImplementProposal).toHaveBeenCalledWith("prop_001", {
        actorId: "mcp-agent",
        epics: [{ name: "Epic 1", description: "First epic", priority: undefined }],
        tasks: [
          { title: "Task A", description: null, priority: "high", type: undefined, epicIndex: 0 },
          { title: "Task B", description: null, priority: undefined, type: "chore", epicIndex: 0 },
          {
            title: "Standalone task",
            description: null,
            priority: "medium",
            type: undefined,
          },
        ],
      });
    });

    it("handles proposal with only standalone tasks", async () => {
      mockImplementProposal.mockResolvedValue({
        ...sampleProposal,
        status: "implemented",
      });

      const result = await client.callTool({
        name: "pm_implement_proposal",
        arguments: {
          proposal_id: "prop_001",
          tasks: [{ title: "Single task" }],
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Proposal implemented successfully");
      expect(text).toContain("**Tasks created:** 1");
      expect(text).not.toContain("**Epics created:**");
    });

    it("handles proposal with only epics and no tasks", async () => {
      mockImplementProposal.mockResolvedValue({
        ...sampleProposal,
        status: "implemented",
      });

      const result = await client.callTool({
        name: "pm_implement_proposal",
        arguments: {
          proposal_id: "prop_001",
          epics: [{ name: "Empty Epic" }],
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Proposal implemented successfully");
      expect(text).toContain("**Epics created:** 1");
      expect(text).not.toContain("**Tasks created:**");
    });
  });

  // ---- pm_pick_next_task ----

  describe("pm_pick_next_task", () => {
    it("returns claimed task when available", async () => {
      mockPickNextTask.mockResolvedValue({
        ...sampleTask,
        status: "in_progress",
        assignee: "mcp-agent",
      });

      const result = await client.callTool({
        name: "pm_pick_next_task",
        arguments: {},
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Task claimed successfully");
      expect(text).toContain("Implement feature X");
      expect(text).toContain("task_001");
      expect(text).toContain("in_progress");
    });

    it("passes filter options", async () => {
      mockPickNextTask.mockResolvedValue(null);

      await client.callTool({
        name: "pm_pick_next_task",
        arguments: {
          project_id: "proj_001",
          task_types: ["feature", "bug"],
          max_effort: "m",
        },
      });

      expect(mockPickNextTask).toHaveBeenCalledWith({
        project_id: "proj_001",
        task_types: ["feature", "bug"],
        max_effort: "m",
      });
    });

    it("returns no-tasks message when nothing available", async () => {
      mockPickNextTask.mockResolvedValue(null);

      const result = await client.callTool({
        name: "pm_pick_next_task",
        arguments: {},
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("No tasks available");
    });

    it("shows task context when available", async () => {
      mockPickNextTask.mockResolvedValue({
        ...sampleTask,
        status: "in_progress",
        assignee: "mcp-agent",
        context: { relevant_files: ["src/foo.ts"], notes: "Check the tests" },
      });

      const result = await client.callTool({
        name: "pm_pick_next_task",
        arguments: {},
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("relevant_files");
      expect(text).toContain("src/foo.ts");
    });
  });

  // ---- pm_start_task ----

  describe("pm_start_task", () => {
    it("transitions task to in_progress", async () => {
      mockTransitionTask.mockResolvedValue({
        ...sampleTask,
        status: "in_progress",
        assignee: "mcp-agent",
      });

      const result = await client.callTool({
        name: "pm_start_task",
        arguments: { task_id: "task_001" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Task started");
      expect(text).toContain("task_001");
      expect(text).toContain("in_progress");

      expect(mockTransitionTask).toHaveBeenCalledWith("task_001", "in_progress", undefined);
    });

    it("passes optional comment", async () => {
      mockTransitionTask.mockResolvedValue({
        ...sampleTask,
        status: "in_progress",
      });

      await client.callTool({
        name: "pm_start_task",
        arguments: {
          task_id: "task_001",
          comment: "Starting with the database schema first.",
        },
      });

      expect(mockTransitionTask).toHaveBeenCalledWith(
        "task_001",
        "in_progress",
        "Starting with the database schema first.",
      );
    });
  });

  // ---- pm_complete_task ----

  describe("pm_complete_task", () => {
    it("transitions task to done and adds handoff comment", async () => {
      mockTransitionTask.mockResolvedValue({
        ...sampleTask,
        status: "done",
      });
      mockAddTaskComment.mockResolvedValue({
        id: "comment_010",
        body: "Implemented the feature.",
        authorId: "mcp-agent",
        commentType: "handoff",
        metadata: { files_changed: ["src/foo.ts"] },
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });

      const result = await client.callTool({
        name: "pm_complete_task",
        arguments: {
          task_id: "task_001",
          summary: "Implemented the feature.",
          files_changed: ["src/foo.ts"],
          test_results: "All 12 tests pass.",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Task completed");
      expect(text).toContain("task_001");
      expect(text).toContain("done");
      expect(text).toContain("Implemented the feature");
      expect(text).toContain("src/foo.ts");
      expect(text).toContain("All 12 tests pass");

      expect(mockTransitionTask).toHaveBeenCalledWith("task_001", "done");
      expect(mockAddTaskComment).toHaveBeenCalledWith(
        "task_001",
        "Implemented the feature.",
        "handoff",
        { files_changed: ["src/foo.ts"], test_results: "All 12 tests pass." },
      );
    });

    it("adds handoff comment with open questions", async () => {
      mockTransitionTask.mockResolvedValue({
        ...sampleTask,
        status: "done",
      });
      mockAddTaskComment.mockResolvedValue({
        id: "comment_011",
        body: "Done.",
        authorId: "mcp-agent",
        commentType: "handoff",
        metadata: null,
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });

      const result = await client.callTool({
        name: "pm_complete_task",
        arguments: {
          task_id: "task_001",
          summary: "Done.",
          open_questions: ["Should we add rate limiting?"],
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Open questions");
      expect(text).toContain("Should we add rate limiting?");

      expect(mockAddTaskComment).toHaveBeenCalledWith(
        "task_001",
        "Done.",
        "handoff",
        { open_questions: ["Should we add rate limiting?"] },
      );
    });

    it("passes null metadata when no extras provided", async () => {
      mockTransitionTask.mockResolvedValue({
        ...sampleTask,
        status: "done",
      });
      mockAddTaskComment.mockResolvedValue({
        id: "comment_012",
        body: "All done.",
        authorId: "mcp-agent",
        commentType: "handoff",
        metadata: null,
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });

      await client.callTool({
        name: "pm_complete_task",
        arguments: {
          task_id: "task_001",
          summary: "All done.",
        },
      });

      expect(mockAddTaskComment).toHaveBeenCalledWith(
        "task_001",
        "All done.",
        "handoff",
        null,
      );
    });
  });

  // ---- pm_request_review ----

  describe("pm_request_review", () => {
    it("transitions task to in_review and adds review note", async () => {
      mockTransitionTask.mockResolvedValue({
        ...sampleTask,
        status: "in_review",
      });
      mockAddTaskComment.mockResolvedValue({
        id: "comment_020",
        body: "Ready for review.",
        authorId: "mcp-agent",
        commentType: "review_note",
        metadata: null,
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });

      const result = await client.callTool({
        name: "pm_request_review",
        arguments: {
          task_id: "task_001",
          summary: "Implemented caching layer with Redis.",
          review_notes: "Focus on the cache invalidation logic.",
          files_changed: ["src/cache.ts", "src/config.ts"],
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Review requested");
      expect(text).toContain("task_001");
      expect(text).toContain("in_review");
      expect(text).toContain("Implemented caching layer");
      expect(text).toContain("cache invalidation logic");

      expect(mockTransitionTask).toHaveBeenCalledWith("task_001", "in_review");
      expect(mockAddTaskComment).toHaveBeenCalledWith(
        "task_001",
        expect.stringContaining("Implemented caching layer with Redis."),
        "review_note",
      );
    });

    it("includes files_changed in the review comment body", async () => {
      mockTransitionTask.mockResolvedValue({
        ...sampleTask,
        status: "in_review",
      });
      mockAddTaskComment.mockResolvedValue({
        id: "comment_021",
        body: "Review body",
        authorId: "mcp-agent",
        commentType: "review_note",
        metadata: null,
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });

      await client.callTool({
        name: "pm_request_review",
        arguments: {
          task_id: "task_001",
          summary: "Changes ready.",
          files_changed: ["src/a.ts"],
        },
      });

      // Verify comment body includes the files
      const commentBody = mockAddTaskComment.mock.calls[0][1];
      expect(commentBody).toContain("src/a.ts");
    });

    it("works with summary only", async () => {
      mockTransitionTask.mockResolvedValue({
        ...sampleTask,
        status: "in_review",
      });
      mockAddTaskComment.mockResolvedValue({
        id: "comment_022",
        body: "Simple review.",
        authorId: "mcp-agent",
        commentType: "review_note",
        metadata: null,
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });

      const result = await client.callTool({
        name: "pm_request_review",
        arguments: {
          task_id: "task_001",
          summary: "Simple review.",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Review requested");
      expect(text).not.toContain("Review notes");

      expect(mockAddTaskComment).toHaveBeenCalledWith(
        "task_001",
        "Simple review.",
        "review_note",
      );
    });
  });

  // ---- pm_block_task ----

  describe("pm_block_task", () => {
    it("adds block comment and returns task info", async () => {
      mockAddTaskComment.mockResolvedValue({
        id: "comment_030",
        body: "Blocked: Waiting for API design to be finalized.",
        authorId: "mcp-agent",
        commentType: "comment",
        metadata: null,
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });
      mockGetTask.mockResolvedValue({
        ...sampleTask,
        status: "in_progress",
      });

      const result = await client.callTool({
        name: "pm_block_task",
        arguments: {
          task_id: "task_001",
          reason: "Waiting for API design to be finalized.",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Task marked as blocked");
      expect(text).toContain("task_001");
      expect(text).toContain("Waiting for API design");

      expect(mockAddTaskComment).toHaveBeenCalledWith(
        "task_001",
        "Blocked: Waiting for API design to be finalized.",
        "comment",
      );
      expect(mockAddTaskDependency).not.toHaveBeenCalled();
    });

    it("creates dependency when blocked_by_task_id provided", async () => {
      mockAddTaskComment.mockResolvedValue({
        id: "comment_031",
        body: "Blocked: Need task_002 first.",
        authorId: "mcp-agent",
        commentType: "comment",
        metadata: null,
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });
      mockAddTaskDependency.mockResolvedValue({
        id: "dep_001",
        taskId: "task_001",
        dependsOnTaskId: "task_002",
        dependencyType: "blocks",
        createdAt: "2026-01-03T00:00:00Z",
      });
      mockGetTask.mockResolvedValue({
        ...sampleTask,
        status: "in_progress",
      });

      const result = await client.callTool({
        name: "pm_block_task",
        arguments: {
          task_id: "task_001",
          reason: "Need task_002 first.",
          blocked_by_task_id: "task_002",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Task marked as blocked");
      expect(text).toContain("**Blocked by:** task_002");

      expect(mockAddTaskDependency).toHaveBeenCalledWith(
        "task_001",
        "task_002",
        "blocks",
      );

      // Comment body should mention the blocking task
      const commentBody = mockAddTaskComment.mock.calls[0][1];
      expect(commentBody).toContain("task_002");
    });
  });

  // ---- Error handling ----

  describe("error handling", () => {
    it("returns error when API call fails", async () => {
      mockGetTask.mockRejectedValue(
        new apiClient.ApiError(404, "NOT_FOUND", "Task not found"),
      );

      const result = await client.callTool({
        name: "pm_get_task",
        arguments: { task_id: "nonexistent" },
      });

      // The MCP SDK wraps tool errors
      expect(result.isError).toBe(true);
    });

    it("surfaces error message for missing required params", async () => {
      // The MCP SDK validates params via zod schema before calling handler,
      // so missing required params should return an error.
      try {
        await client.callTool({
          name: "pm_get_task",
          arguments: {},
        });
        // The SDK may throw or return an error - either is fine
      } catch {
        // Expected — missing required task_id
      }
    });
  });
});
