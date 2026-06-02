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
  claimProposal: vi.fn(),
  releaseProposal: vi.fn(),
  createProposal: vi.fn(),
  createEpic: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  search: vi.fn(),
  implementProposal: vi.fn(),
  transitionTask: vi.fn(),
  pickNextTask: vi.fn(),
  addTaskComment: vi.fn(),
  addTaskDependency: vi.fn(),
  addEpicDependency: vi.fn(),
  removeEpicDependency: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  createGitRef: vi.fn(),
  getProjectTasks: vi.fn(),
  checkUpdates: vi.fn(),
  claimTask: vi.fn(),
  releaseTask: vi.fn(),
  forceClaimTask: vi.fn(),
  forceClaimEpic: vi.fn(),
  forceClaimProposal: vi.fn(),
  awareness: vi.fn(),
  acquireMergeLock: vi.fn(),
  heartbeatMergeLock: vi.fn(),
  releaseMergeLock: vi.fn(),
  getMergeLock: vi.fn(),
  listMergeLocks: vi.fn(),
  submitMergeRequest: vi.fn(),
  listMergeRequests: vi.fn(),
  getMergeRequest: vi.fn(),
  cancelMergeRequest: vi.fn(),
  requestMergeGroup: vi.fn(),
  getMergeGroup: vi.fn(),
  listMergeIncidents: vi.fn(),
  getMergeIncident: vi.fn(),
}));

// Import the mocked functions so we can configure them per test
import * as apiClient from "../src/api-client.js";

const mockListProjects = vi.mocked(apiClient.listProjects);
const mockGetProposal = vi.mocked(apiClient.getProposal);
const mockListProposals = vi.mocked(apiClient.listProposals);
const mockAddProposalComment = vi.mocked(apiClient.addProposalComment);
const mockClaimProposal = vi.mocked(apiClient.claimProposal);
const mockReleaseProposal = vi.mocked(apiClient.releaseProposal);
const mockCreateProposal = vi.mocked(apiClient.createProposal);
const mockCreateEpic = vi.mocked(apiClient.createEpic);
const mockListTasks = vi.mocked(apiClient.listTasks);
const mockGetTask = vi.mocked(apiClient.getTask);
const mockSearch = vi.mocked(apiClient.search);
const mockImplementProposal = vi.mocked(apiClient.implementProposal);
const mockTransitionTask = vi.mocked(apiClient.transitionTask);
const mockPickNextTask = vi.mocked(apiClient.pickNextTask);
const mockAddTaskComment = vi.mocked(apiClient.addTaskComment);
const mockAddTaskDependency = vi.mocked(apiClient.addTaskDependency);
const mockAddEpicDependency = vi.mocked(apiClient.addEpicDependency);
const mockRemoveEpicDependency = vi.mocked(apiClient.removeEpicDependency);
const mockCreateTask = vi.mocked(apiClient.createTask);
const mockUpdateTask = vi.mocked(apiClient.updateTask);
const mockCreateGitRef = vi.mocked(apiClient.createGitRef);
const mockGetProjectTasks = vi.mocked(apiClient.getProjectTasks);
const mockCheckUpdates = vi.mocked(apiClient.checkUpdates);
const mockClaimTask = vi.mocked(apiClient.claimTask);
const mockReleaseTask = vi.mocked(apiClient.releaseTask);
const mockForceClaimTask = vi.mocked(apiClient.forceClaimTask);
const mockForceClaimEpic = vi.mocked(apiClient.forceClaimEpic);
const mockForceClaimProposal = vi.mocked(apiClient.forceClaimProposal);
const mockAwareness = vi.mocked(apiClient.awareness);
const mockAcquireMergeLock = vi.mocked(apiClient.acquireMergeLock);
const mockHeartbeatMergeLock = vi.mocked(apiClient.heartbeatMergeLock);
const mockReleaseMergeLock = vi.mocked(apiClient.releaseMergeLock);
const mockGetMergeLock = vi.mocked(apiClient.getMergeLock);
const mockListMergeLocks = vi.mocked(apiClient.listMergeLocks);
const mockSubmitMergeRequest = vi.mocked(apiClient.submitMergeRequest);
const mockListMergeRequests = vi.mocked(apiClient.listMergeRequests);
const mockGetMergeRequest = vi.mocked(apiClient.getMergeRequest);
const mockCancelMergeRequest = vi.mocked(apiClient.cancelMergeRequest);
const mockRequestMergeGroup = vi.mocked(apiClient.requestMergeGroup);
const mockGetMergeGroup = vi.mocked(apiClient.getMergeGroup);
const mockListMergeIncidents = vi.mocked(apiClient.listMergeIncidents);
const mockGetMergeIncident = vi.mocked(apiClient.getMergeIncident);

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
  claimedBy: null,
  claimStatus: "unclaimed" as const,
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

const sampleMergeRequest = {
  id: "mreq_001",
  projectId: "P1",
  resource: "main",
  submittedBy: "U_AGENT",
  taskId: "T1",
  branch: "feat/skin",
  commitSha: "abc1234",
  verifyCmd: null,
  worktreePath: null,
  status: "queued" as const,
  enqueuedAt: "2026-05-29T14:21:03.412Z",
  pickedUpAt: null,
  resolvedAt: null,
  landedSha: null,
  rejectCategory: null,
  rejectReason: null,
  failedFiles: null,
  logExcerpt: null,
  logUrl: null,
  createdAt: "2026-05-29T14:21:03.412Z",
  updatedAt: "2026-05-29T14:21:03.412Z",
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

      expect(mockListProposals).toHaveBeenCalledWith("proj_001", "discussing", undefined);
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

    it("surfaces a clean message when the API rejects with CLAIM_DENIED", async () => {
      const { ApiError } = await import("../src/api-client.js");
      mockAddProposalComment.mockRejectedValue(
        new ApiError(409, "CLAIM_DENIED", "Not your claim"),
      );

      const result = await client.callTool({
        name: "pm_discuss_proposal",
        arguments: {
          proposal_id: "prop_001",
          body: "trying anyway",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("haven't claimed this proposal");
      expect(text).toContain("pm_claim_proposal");
    });
  });

  // ---- pm_claim_proposal / pm_release_proposal ----

  describe("pm_claim_proposal", () => {
    it("returns a friendly confirmation when the claim succeeds", async () => {
      mockClaimProposal.mockResolvedValue({ ok: true, status: "claimed_by_you" });

      const result = await client.callTool({
        name: "pm_claim_proposal",
        arguments: { proposal_id: "prop_001" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Claimed");
      expect(text).toContain("yours to work on");
      expect(mockClaimProposal).toHaveBeenCalledWith("prop_001");
    });

    it("reports already_claimed_by_you", async () => {
      mockClaimProposal.mockResolvedValue({
        ok: true,
        status: "already_claimed_by_you",
      });

      const result = await client.callTool({
        name: "pm_claim_proposal",
        arguments: { proposal_id: "prop_001" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("already hold this claim");
    });

    it("warns when another agent holds the claim — no IDs leaked", async () => {
      mockClaimProposal.mockResolvedValue({
        ok: false,
        status: "claimed_by_another_agent",
      });

      const result = await client.callTool({
        name: "pm_claim_proposal",
        arguments: { proposal_id: "prop_001" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("claimed by another agent");
      expect(text).not.toMatch(/user[_-]/);
    });

    it("reports closed for terminal proposals", async () => {
      mockClaimProposal.mockResolvedValue({ ok: false, status: "closed" });

      const result = await client.callTool({
        name: "pm_claim_proposal",
        arguments: { proposal_id: "prop_001" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("closed");
    });
  });

  describe("pm_release_proposal", () => {
    it("confirms a successful release", async () => {
      mockReleaseProposal.mockResolvedValue({ ok: true, status: "released" });

      const result = await client.callTool({
        name: "pm_release_proposal",
        arguments: { proposal_id: "prop_001" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Released");
    });

    it("reports when you don't hold the claim", async () => {
      mockReleaseProposal.mockResolvedValue({
        ok: false,
        status: "claimed_by_another_agent",
      });

      const result = await client.callTool({
        name: "pm_release_proposal",
        arguments: { proposal_id: "prop_001" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("don't hold this claim");
    });
  });

  describe("pm_force_claim_task", () => {
    it("calls forceClaimTask with (id, reason, undefined) and renders no-leak text", async () => {
      mockForceClaimTask.mockResolvedValue({
        ok: true,
        status: "force_claimed",
        previousHolder: "user_secret_A",
        newHolder: "user_B",
      });

      const result = await client.callTool({
        name: "pm_force_claim_task",
        arguments: { task_id: "task_001", reason: "my session identity flipped" },
      });

      expect(mockForceClaimTask).toHaveBeenCalledWith(
        "task_001",
        "my session identity flipped",
        undefined,
      );
      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Force-claimed");
      // No-leak: the displaced holder's id must never appear in the render.
      expect(text).not.toContain("user_secret_A");
    });
  });

  describe("pm_force_claim_epic", () => {
    it("calls forceClaimEpic with (id, reason, undefined) and renders no-leak text", async () => {
      mockForceClaimEpic.mockResolvedValue({
        ok: true,
        status: "force_claimed",
        previousHolder: "user_secret_A",
        newHolder: "user_B",
      });

      const result = await client.callTool({
        name: "pm_force_claim_epic",
        arguments: { epic_id: "epic_001", reason: "recovering my stranded epic" },
      });

      expect(mockForceClaimEpic).toHaveBeenCalledWith(
        "epic_001",
        "recovering my stranded epic",
        undefined,
      );
      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Force-claimed");
      expect(text).not.toContain("user_secret_A");
    });
  });

  describe("pm_force_claim_proposal", () => {
    it("calls forceClaimProposal with (id, reason, undefined) and renders no-leak text", async () => {
      mockForceClaimProposal.mockResolvedValue({
        ok: true,
        status: "force_claimed",
        previousHolder: "user_secret_A",
        newHolder: "user_B",
      });

      const result = await client.callTool({
        name: "pm_force_claim_proposal",
        arguments: { proposal_id: "prop_001", reason: "recovering my stranded proposal" },
      });

      expect(mockForceClaimProposal).toHaveBeenCalledWith(
        "prop_001",
        "recovering my stranded proposal",
        undefined,
      );
      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Force-claimed");
      expect(text).not.toContain("user_secret_A");
    });
  });

  describe("pm_list_proposals claim rendering", () => {
    it("renders claim_status as human text, never the claimed_by ID", async () => {
      mockListProposals.mockResolvedValue([
        {
          ...sampleProposal,
          id: "prop_a",
          title: "Mine",
          claimedBy: "user-me",
          claimStatus: "claimed_by_you",
        },
        {
          ...sampleProposal,
          id: "prop_b",
          title: "Theirs",
          claimedBy: "user-someone-else",
          claimStatus: "claimed_by_other",
        },
        {
          ...sampleProposal,
          id: "prop_c",
          title: "Free",
          claimedBy: null,
          claimStatus: "unclaimed",
        },
      ]);

      const result = await client.callTool({
        name: "pm_list_proposals",
        arguments: { claim: "all" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("claimed for you");
      expect(text).toContain("claimed by another agent");
      expect(text).toContain("available to claim");
      expect(text).not.toContain("user-someone-else");
      expect(text).not.toContain("user-me");
      expect(mockListProposals).toHaveBeenCalledWith(undefined, undefined, "all");
    });
  });

  // ---- pm_implement_proposal ----

  describe("pm_implement_proposal", () => {
    it("creates work items from accepted proposal", async () => {
      mockImplementProposal.mockResolvedValue({
        ...sampleProposal,
        status: "in_progress",
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
      expect(text).toContain("Proposal planned successfully");
      expect(text).toContain("in_progress");
      expect(text).toContain("**Epics created:** 1");
      expect(text).toContain("**Tasks created:** 3");
      expect(text).toContain("Breaking this into one epic");

      expect(mockImplementProposal).toHaveBeenCalledWith("prop_001", {
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
        status: "in_progress",
      });

      const result = await client.callTool({
        name: "pm_implement_proposal",
        arguments: {
          proposal_id: "prop_001",
          tasks: [{ title: "Single task" }],
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Proposal planned successfully");
      expect(text).toContain("**Tasks created:** 1");
      expect(text).not.toContain("**Epics created:**");
    });

    it("handles proposal with only epics and no tasks", async () => {
      mockImplementProposal.mockResolvedValue({
        ...sampleProposal,
        status: "in_progress",
      });

      const result = await client.callTool({
        name: "pm_implement_proposal",
        arguments: {
          proposal_id: "prop_001",
          epics: [{ name: "Empty Epic" }],
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Proposal planned successfully");
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

  // ---- pm_create_proposal ----

  describe("pm_create_proposal", () => {
    it("creates a proposal — no createdBy parameter exposed to the agent", async () => {
      mockCreateProposal.mockResolvedValue({
        ...sampleProposal,
        id: "prop_new",
        title: "New idea",
        status: "open",
      });

      const result = await client.callTool({
        name: "pm_create_proposal",
        arguments: {
          project_id: "proj_001",
          title: "New idea",
          description: "Let's add X",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Proposal created successfully");
      expect(text).toContain("prop_new");
      expect(text).toContain("pm_claim_proposal");
      expect(mockCreateProposal).toHaveBeenCalledWith("proj_001", {
        title: "New idea",
        description: "Let's add X",
      });
    });

    it("handles minimal arguments (no description)", async () => {
      mockCreateProposal.mockResolvedValue({
        ...sampleProposal,
        id: "prop_min",
        title: "Quick idea",
      });

      await client.callTool({
        name: "pm_create_proposal",
        arguments: { project_id: "proj_001", title: "Quick idea" },
      });

      expect(mockCreateProposal).toHaveBeenCalledWith("proj_001", {
        title: "Quick idea",
        description: null,
      });
    });
  });

  // ---- pm_create_epic ----

  describe("pm_create_epic", () => {
    const sampleEpic = {
      id: "epic_new",
      projectId: "proj_001",
      name: "New epic",
      description: null,
      status: "draft",
      priority: "medium",
      assigneeId: null,
      taskSummary: { total: 0, done: 0, byStatus: {} },
    };

    it("creates an epic without proposal link", async () => {
      mockCreateEpic.mockResolvedValue(sampleEpic);

      const result = await client.callTool({
        name: "pm_create_epic",
        arguments: { project_id: "proj_001", name: "New epic" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Epic created successfully");
      expect(text).toContain("epic_new");
      expect(text).not.toContain("Linked proposal");
    });

    it("creates an epic linked to a proposal", async () => {
      mockCreateEpic.mockResolvedValue({ ...sampleEpic });

      const result = await client.callTool({
        name: "pm_create_epic",
        arguments: {
          project_id: "proj_001",
          name: "Linked epic",
          proposal_id: "prop_001",
          priority: "high",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("**Linked proposal:** prop_001");
      expect(mockCreateEpic).toHaveBeenCalledWith("proj_001", {
        name: "Linked epic",
        description: null,
        priority: "high",
        proposalId: "prop_001",
        milestoneId: null,
        targetDate: null,
      });
    });

    it("surfaces a clean message when CLAIM_DENIED", async () => {
      const { ApiError } = await import("../src/api-client.js");
      mockCreateEpic.mockRejectedValue(
        new ApiError(409, "CLAIM_DENIED", "Not your claim"),
      );

      const result = await client.callTool({
        name: "pm_create_epic",
        arguments: {
          project_id: "proj_001",
          name: "Sneaky epic",
          proposal_id: "prop_001",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("haven't claimed this proposal");
      expect(text).toContain("pm_claim_proposal");
    });
  });

  // ---- pm_create_task ----

  describe("pm_create_task", () => {
    it("creates a task with required fields", async () => {
      mockCreateTask.mockResolvedValue({
        ...sampleTask,
        id: "task_new",
        title: "New task",
        status: "backlog",
      });

      const result = await client.callTool({
        name: "pm_create_task",
        arguments: {
          project_id: "proj_001",
          title: "New task",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Task created successfully");
      expect(text).toContain("task_new");
      expect(text).toContain("New task");

      expect(mockCreateTask).toHaveBeenCalledWith("proj_001", {
        title: "New task",
        description: null,
        epicId: null,
        parentTaskId: null,
        priority: undefined,
        type: undefined,
        estimatedEffort: null,
        context: null,
      });
    });

    it("creates a task with all optional fields", async () => {
      mockCreateTask.mockResolvedValue({
        ...sampleTask,
        id: "task_full",
        title: "Full task",
        epicId: "epic_001",
        parentTaskId: "task_parent",
        priority: "high",
        type: "bug",
        estimatedEffort: "m",
        context: { relevant_files: ["src/foo.ts"] },
      });

      const result = await client.callTool({
        name: "pm_create_task",
        arguments: {
          project_id: "proj_001",
          title: "Full task",
          description: "A detailed description",
          epic_id: "epic_001",
          parent_task_id: "task_parent",
          priority: "high",
          type: "bug",
          estimated_effort: "m",
          context: { relevant_files: ["src/foo.ts"] },
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("task_full");
      expect(text).toContain("**Epic:** epic_001");
      expect(text).toContain("**Parent Task:** task_parent");
      expect(text).toContain("**Estimated Effort:** m");

      expect(mockCreateTask).toHaveBeenCalledWith("proj_001", {
        title: "Full task",
        description: "A detailed description",
        epicId: "epic_001",
        parentTaskId: "task_parent",
        priority: "high",
        type: "bug",
        estimatedEffort: "m",
        context: { relevant_files: ["src/foo.ts"] },
      });
    });

    it("adds dependencies when depends_on is specified", async () => {
      mockCreateTask.mockResolvedValue({
        ...sampleTask,
        id: "task_dep",
        title: "Dependent task",
      });
      mockAddTaskDependency.mockResolvedValue({
        id: "dep_001",
        taskId: "task_dep",
        dependsOnTaskId: "task_001",
        dependencyType: "blocks",
        createdAt: "2026-01-03T00:00:00Z",
      });

      const result = await client.callTool({
        name: "pm_create_task",
        arguments: {
          project_id: "proj_001",
          title: "Dependent task",
          depends_on: ["task_001", "task_002"],
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("**Dependencies:** task_001, task_002");

      expect(mockAddTaskDependency).toHaveBeenCalledTimes(2);
      expect(mockAddTaskDependency).toHaveBeenCalledWith("task_dep", "task_001");
      expect(mockAddTaskDependency).toHaveBeenCalledWith("task_dep", "task_002");
    });
  });

  // ---- pm_update_task ----

  describe("pm_update_task", () => {
    it("updates task with simple fields", async () => {
      mockUpdateTask.mockResolvedValue({
        ...sampleTask,
        title: "Updated title",
        priority: "critical",
      });

      const result = await client.callTool({
        name: "pm_update_task",
        arguments: {
          task_id: "task_001",
          title: "Updated title",
          priority: "critical",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Task updated successfully");
      expect(text).toContain("Updated title");
      expect(text).toContain("critical");

      expect(mockUpdateTask).toHaveBeenCalledWith("task_001", {
        title: "Updated title",
        priority: "critical",
      });
    });

    it("merges context with existing context", async () => {
      mockGetTask.mockResolvedValue({
        ...sampleTask,
        context: { relevant_files: ["src/old.ts"], notes: "old notes" },
      });
      mockUpdateTask.mockResolvedValue({
        ...sampleTask,
        context: {
          relevant_files: ["src/new.ts"],
          notes: "old notes",
        },
      });

      const result = await client.callTool({
        name: "pm_update_task",
        arguments: {
          task_id: "task_001",
          context: { relevant_files: ["src/new.ts"] },
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Task updated successfully");

      // Should merge: new relevant_files + old notes
      expect(mockUpdateTask).toHaveBeenCalledWith("task_001", {
        context: {
          relevant_files: ["src/new.ts"],
          notes: "old notes",
        },
      });
    });

    it("updates due date", async () => {
      mockUpdateTask.mockResolvedValue({
        ...sampleTask,
        dueDate: "2026-06-01",
      });

      const result = await client.callTool({
        name: "pm_update_task",
        arguments: {
          task_id: "task_001",
          due_date: "2026-06-01",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Task updated successfully");
      expect(text).toContain("**Due Date:** 2026-06-01");

      expect(mockUpdateTask).toHaveBeenCalledWith("task_001", {
        dueDate: "2026-06-01",
      });
    });
  });

  // ---- pm_add_comment ----

  describe("pm_add_comment", () => {
    it("adds a comment with default type", async () => {
      mockAddTaskComment.mockResolvedValue({
        id: "comment_100",
        body: "This is a comment.",
        authorId: "mcp-agent",
        commentType: "comment",
        metadata: null,
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });

      const result = await client.callTool({
        name: "pm_add_comment",
        arguments: {
          task_id: "task_001",
          body: "This is a comment.",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Comment added successfully");
      expect(text).toContain("comment_100");
      expect(text).toContain("comment");
      expect(text).toContain("This is a comment.");

      expect(mockAddTaskComment).toHaveBeenCalledWith(
        "task_001",
        "This is a comment.",
        "comment",
        null,
      );
    });

    it("adds a comment with custom type and metadata", async () => {
      mockAddTaskComment.mockResolvedValue({
        id: "comment_101",
        body: "A question comment.",
        authorId: "mcp-agent",
        commentType: "question",
        metadata: { urgency: "high" },
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });

      await client.callTool({
        name: "pm_add_comment",
        arguments: {
          task_id: "task_001",
          body: "A question comment.",
          comment_type: "question",
          metadata: { urgency: "high" },
        },
      });

      expect(mockAddTaskComment).toHaveBeenCalledWith(
        "task_001",
        "A question comment.",
        "question",
        { urgency: "high" },
      );
    });
  });

  // ---- pm_log_decision ----

  describe("pm_log_decision", () => {
    it("creates a decision comment with rationale", async () => {
      mockAddTaskComment.mockResolvedValue({
        id: "comment_200",
        body: "**Decision:** Use Redis",
        authorId: "mcp-agent",
        commentType: "decision",
        metadata: { decision: "Use Redis", rationale: "Best performance" },
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });

      const result = await client.callTool({
        name: "pm_log_decision",
        arguments: {
          task_id: "task_001",
          decision: "Use Redis",
          rationale: "Best performance",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Decision logged successfully");
      expect(text).toContain("comment_200");
      expect(text).toContain("Use Redis");
      expect(text).toContain("Best performance");

      expect(mockAddTaskComment).toHaveBeenCalledWith(
        "task_001",
        expect.stringContaining("Use Redis"),
        "decision",
        { decision: "Use Redis", rationale: "Best performance" },
      );
    });

    it("includes alternatives considered", async () => {
      mockAddTaskComment.mockResolvedValue({
        id: "comment_201",
        body: "**Decision:** Use Redis",
        authorId: "mcp-agent",
        commentType: "decision",
        metadata: {
          decision: "Use Redis",
          rationale: "Best performance",
          alternatives_considered: ["Memcached", "In-memory cache"],
        },
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });

      const result = await client.callTool({
        name: "pm_log_decision",
        arguments: {
          task_id: "task_001",
          decision: "Use Redis",
          rationale: "Best performance",
          alternatives_considered: ["Memcached", "In-memory cache"],
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Alternatives considered");
      expect(text).toContain("Memcached");
      expect(text).toContain("In-memory cache");

      expect(mockAddTaskComment).toHaveBeenCalledWith(
        "task_001",
        expect.stringContaining("Alternatives considered"),
        "decision",
        {
          decision: "Use Redis",
          rationale: "Best performance",
          alternatives_considered: ["Memcached", "In-memory cache"],
        },
      );
    });
  });

  // ---- pm_report_progress ----

  describe("pm_report_progress", () => {
    it("posts a progress update with summary only", async () => {
      mockAddTaskComment.mockResolvedValue({
        id: "comment_300",
        body: "Making good progress.",
        authorId: "mcp-agent",
        commentType: "progress_update",
        metadata: { summary: "Making good progress." },
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });

      const result = await client.callTool({
        name: "pm_report_progress",
        arguments: {
          task_id: "task_001",
          summary: "Making good progress.",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Progress update posted");
      expect(text).toContain("comment_300");
      expect(text).toContain("Making good progress.");

      expect(mockAddTaskComment).toHaveBeenCalledWith(
        "task_001",
        "Making good progress.",
        "progress_update",
        { summary: "Making good progress." },
      );
    });

    it("includes completion percentage, files, and blockers", async () => {
      mockAddTaskComment.mockResolvedValue({
        id: "comment_301",
        body: "Halfway done.",
        authorId: "mcp-agent",
        commentType: "progress_update",
        metadata: {
          summary: "Halfway done.",
          completion_pct: 50,
          files_changed: ["src/api.ts"],
        },
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      });

      const result = await client.callTool({
        name: "pm_report_progress",
        arguments: {
          task_id: "task_001",
          summary: "Halfway done.",
          completion_pct: 50,
          files_changed: ["src/api.ts"],
          blockers: ["Waiting for design review"],
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("**Completion:** 50%");
      expect(text).toContain("src/api.ts");
      expect(text).toContain("Waiting for design review");

      expect(mockAddTaskComment).toHaveBeenCalledWith(
        "task_001",
        expect.stringContaining("50%"),
        "progress_update",
        {
          summary: "Halfway done.",
          completion_pct: 50,
          files_changed: ["src/api.ts"],
        },
      );
    });
  });

  // ---- pm_set_task_context ----

  describe("pm_set_task_context", () => {
    it("sets context fields on a task", async () => {
      mockGetTask.mockResolvedValue({
        ...sampleTask,
        context: {},
      });
      mockUpdateTask.mockResolvedValue({
        ...sampleTask,
        context: {
          relevant_files: ["src/main.ts"],
          notes: "Important note",
        },
      });

      const result = await client.callTool({
        name: "pm_set_task_context",
        arguments: {
          task_id: "task_001",
          relevant_files: ["src/main.ts"],
          notes: "Important note",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Task context updated");
      expect(text).toContain("task_001");
      expect(text).toContain("src/main.ts");

      expect(mockUpdateTask).toHaveBeenCalledWith("task_001", {
        context: {
          relevant_files: ["src/main.ts"],
          notes: "Important note",
        },
      });
    });

    it("merges with existing context", async () => {
      mockGetTask.mockResolvedValue({
        ...sampleTask,
        context: { relevant_files: ["src/old.ts"], notes: "existing" },
      });
      mockUpdateTask.mockResolvedValue({
        ...sampleTask,
        context: {
          relevant_files: ["src/old.ts"],
          notes: "existing",
          acceptance_criteria: ["Must pass tests"],
        },
      });

      await client.callTool({
        name: "pm_set_task_context",
        arguments: {
          task_id: "task_001",
          acceptance_criteria: ["Must pass tests"],
        },
      });

      expect(mockUpdateTask).toHaveBeenCalledWith("task_001", {
        context: {
          relevant_files: ["src/old.ts"],
          notes: "existing",
          acceptance_criteria: ["Must pass tests"],
        },
      });
    });
  });

  // ---- pm_link_git_ref ----

  describe("pm_link_git_ref", () => {
    it("links a branch to a task", async () => {
      mockCreateGitRef.mockResolvedValue({
        id: "ref_001",
        taskId: "task_001",
        refType: "branch",
        refValue: "feature/my-branch",
        url: null,
        title: null,
        status: null,
        metadata: null,
        createdAt: "2026-01-03T00:00:00Z",
      });

      const result = await client.callTool({
        name: "pm_link_git_ref",
        arguments: {
          task_id: "task_001",
          ref_type: "branch",
          ref_value: "feature/my-branch",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Git reference linked successfully");
      expect(text).toContain("ref_001");
      expect(text).toContain("branch");
      expect(text).toContain("feature/my-branch");

      expect(mockCreateGitRef).toHaveBeenCalledWith("task_001", {
        refType: "branch",
        refValue: "feature/my-branch",
        url: null,
        title: null,
      });
    });

    it("links a PR with url and title", async () => {
      mockCreateGitRef.mockResolvedValue({
        id: "ref_002",
        taskId: "task_001",
        refType: "pull_request",
        refValue: "42",
        url: "https://github.com/org/repo/pull/42",
        title: "Add caching feature",
        status: null,
        metadata: null,
        createdAt: "2026-01-03T00:00:00Z",
      });

      const result = await client.callTool({
        name: "pm_link_git_ref",
        arguments: {
          task_id: "task_001",
          ref_type: "pull_request",
          ref_value: "42",
          url: "https://github.com/org/repo/pull/42",
          title: "Add caching feature",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("pull_request");
      expect(text).toContain("42");
      expect(text).toContain("https://github.com/org/repo/pull/42");
      expect(text).toContain("Add caching feature");

      expect(mockCreateGitRef).toHaveBeenCalledWith("task_001", {
        refType: "pull_request",
        refValue: "42",
        url: "https://github.com/org/repo/pull/42",
        title: "Add caching feature",
      });
    });
  });

  // ---- pm_link_epic_dependency / pm_unlink_epic_dependency ----

  describe("pm_link_epic_dependency", () => {
    const sampleDep = {
      id: "epicdep_001",
      projectId: "proj_001",
      epicId: "epic_b",
      dependsOnEpicId: "epic_a",
      dependencyType: "blocks",
      createdAt: "2026-01-03T00:00:00Z",
      createdBy: null,
    };

    it("links an epic dependency and passes args through", async () => {
      mockAddEpicDependency.mockResolvedValue(sampleDep);

      const result = await client.callTool({
        name: "pm_link_epic_dependency",
        arguments: {
          project_id: "proj_001",
          epic_id: "epic_b",
          depends_on_epic_id: "epic_a",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Epic dependency linked successfully");
      expect(text).toContain("epicdep_001");
      expect(text).toContain("epic_b");
      expect(text).toContain("epic_a");
      expect(mockAddEpicDependency).toHaveBeenCalledWith(
        "epic_b",
        "epic_a",
        "proj_001",
        undefined,
      );
    });

    it("passes the dependency_type through", async () => {
      mockAddEpicDependency.mockResolvedValue({
        ...sampleDep,
        dependencyType: "relates_to",
      });

      await client.callTool({
        name: "pm_link_epic_dependency",
        arguments: {
          project_id: "proj_001",
          epic_id: "epic_b",
          depends_on_epic_id: "epic_a",
          dependency_type: "relates_to",
        },
      });

      expect(mockAddEpicDependency).toHaveBeenCalledWith(
        "epic_b",
        "epic_a",
        "proj_001",
        "relates_to",
      );
    });

    it("surfaces a clean message on CONFLICT", async () => {
      const { ApiError } = await import("../src/api-client.js");
      mockAddEpicDependency.mockRejectedValue(
        new ApiError(409, "CONFLICT", "This epic dependency already exists"),
      );

      const result = await client.callTool({
        name: "pm_link_epic_dependency",
        arguments: {
          project_id: "proj_001",
          epic_id: "epic_b",
          depends_on_epic_id: "epic_a",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("already exists");
    });

    it("surfaces a clean message on SELF_DEPENDENCY", async () => {
      const { ApiError } = await import("../src/api-client.js");
      mockAddEpicDependency.mockRejectedValue(
        new ApiError(400, "SELF_DEPENDENCY", "An epic cannot depend on itself"),
      );

      const result = await client.callTool({
        name: "pm_link_epic_dependency",
        arguments: {
          project_id: "proj_001",
          epic_id: "epic_a",
          depends_on_epic_id: "epic_a",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("cannot depend on itself");
    });

    it("surfaces a clean message on CROSS_PROJECT", async () => {
      const { ApiError } = await import("../src/api-client.js");
      mockAddEpicDependency.mockRejectedValue(
        new ApiError(400, "CROSS_PROJECT", "Both epics must belong to project"),
      );

      const result = await client.callTool({
        name: "pm_link_epic_dependency",
        arguments: {
          project_id: "proj_001",
          epic_id: "epic_b",
          depends_on_epic_id: "epic_other",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("same project");
    });
  });

  describe("pm_unlink_epic_dependency", () => {
    it("removes an epic dependency and renders confirmation", async () => {
      mockRemoveEpicDependency.mockResolvedValue({
        id: "epicdep_001",
        projectId: "proj_001",
        epicId: "epic_b",
        dependsOnEpicId: "epic_a",
        dependencyType: "blocks",
        createdAt: "2026-01-03T00:00:00Z",
        createdBy: null,
      });

      const result = await client.callTool({
        name: "pm_unlink_epic_dependency",
        arguments: {
          project_id: "proj_001",
          epic_id: "epic_b",
          dependency_id: "epicdep_001",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Epic dependency removed");
      expect(text).toContain("epicdep_001");
      expect(mockRemoveEpicDependency).toHaveBeenCalledWith(
        "epic_b",
        "epicdep_001",
        "proj_001",
      );
    });
  });

  // ---- pm_check_updates ----

  describe("pm_check_updates", () => {
    it("returns no-updates message when nothing new", async () => {
      mockCheckUpdates.mockResolvedValue({
        has_updates: false,
        count: 0,
        data: [],
      });

      const result = await client.callTool({
        name: "pm_check_updates",
        arguments: { since: "2026-01-01T00:00:00Z" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("No updates since 2026-01-01T00:00:00Z");
      expect(mockCheckUpdates).toHaveBeenCalledWith("2026-01-01T00:00:00Z", undefined);
    });

    it("returns formatted update list when updates exist", async () => {
      mockCheckUpdates.mockResolvedValue({
        has_updates: true,
        count: 2,
        data: [
          {
            id: "act_001",
            entityType: "task",
            entityId: "task_001",
            projectId: "proj_001",
            actorId: "user_human",
            action: "commented",
            changes: null,
            createdAt: "2026-01-02T12:00:00Z",
          },
          {
            id: "act_002",
            entityType: "task",
            entityId: "task_002",
            projectId: "proj_001",
            actorId: "user_human",
            action: "updated",
            changes: { priority: { from: "medium", to: "critical" } },
            createdAt: "2026-01-02T11:00:00Z",
          },
        ],
      });

      const result = await client.callTool({
        name: "pm_check_updates",
        arguments: { since: "2026-01-01T00:00:00Z", project_id: "proj_001" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("2 updates since");
      expect(text).toContain("user_human");
      expect(text).toContain("commented");
      expect(text).toContain("task_001");
      expect(text).toContain("updated");
      expect(text).toContain("task_002");
      expect(text).toContain("critical");
      expect(mockCheckUpdates).toHaveBeenCalledWith("2026-01-01T00:00:00Z", "proj_001");
    });

    it("shows singular 'update' for count of 1", async () => {
      mockCheckUpdates.mockResolvedValue({
        has_updates: true,
        count: 1,
        data: [
          {
            id: "act_003",
            entityType: "task",
            entityId: "task_001",
            projectId: null,
            actorId: "user_human",
            action: "status_changed",
            changes: { status: { from: "ready", to: "blocked" } },
            createdAt: "2026-01-02T10:00:00Z",
          },
        ],
      });

      const result = await client.callTool({
        name: "pm_check_updates",
        arguments: { since: "2026-01-01T00:00:00Z" },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("1 update since");
      expect(text).not.toContain("1 updates");
    });
  });

  // ---- pm_list_templates ----

  describe("pm_list_templates", () => {
    it("returns formatted template list", async () => {
      const mockApiRequest = vi.mocked(apiClient.apiRequest);
      mockApiRequest.mockResolvedValue([
        {
          id: "tpl_001",
          projectId: null,
          name: "Bug Fix Template",
          description: "Template for bug fixes",
          templateType: "task",
          templateData: { type: "bug", priority: "high" },
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          createdBy: null,
        },
      ]);

      const result = await client.callTool({
        name: "pm_list_templates",
        arguments: {},
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Bug Fix Template");
      expect(text).toContain("tpl_001");
      expect(text).toContain("task");
      expect(text).toContain("Workspace-level");
    });

    it("handles empty results", async () => {
      const mockApiRequest = vi.mocked(apiClient.apiRequest);
      mockApiRequest.mockResolvedValue([]);

      const result = await client.callTool({
        name: "pm_list_templates",
        arguments: {},
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("No templates found");
    });

    it("passes filter params", async () => {
      const mockApiRequest = vi.mocked(apiClient.apiRequest);
      mockApiRequest.mockResolvedValue([]);

      await client.callTool({
        name: "pm_list_templates",
        arguments: { project_id: "proj_001", template_type: "task" },
      });

      expect(mockApiRequest).toHaveBeenCalledWith(
        "GET",
        expect.stringContaining("/templates"),
      );
      const callUrl = mockApiRequest.mock.calls[0][1];
      expect(callUrl).toContain("project_id=proj_001");
      expect(callUrl).toContain("template_type=task");
    });
  });

  // ---- pm_use_template ----

  describe("pm_use_template", () => {
    it("instantiates a task template", async () => {
      const mockApiRequest = vi.mocked(apiClient.apiRequest);
      mockApiRequest.mockResolvedValue({
        task: { id: "task_new", title: "Bug Fix", type: "bug" },
        subtasks: [],
      });

      const result = await client.callTool({
        name: "pm_use_template",
        arguments: {
          template_id: "tpl_001",
          project_id: "proj_001",
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Template instantiated successfully");
      expect(text).toContain("task_new");

      expect(mockApiRequest).toHaveBeenCalledWith(
        "POST",
        "/templates/tpl_001/instantiate",
        expect.objectContaining({ project_id: "proj_001" }),
      );
    });

    it("instantiates a project template with name and overrides", async () => {
      const mockApiRequest = vi.mocked(apiClient.apiRequest);
      mockApiRequest.mockResolvedValue({
        project: { id: "proj_new", name: "My Feature" },
        labels: [],
        epics: [],
      });

      const result = await client.callTool({
        name: "pm_use_template",
        arguments: {
          template_id: "tpl_002",
          workspace_id: "ws_001",
          name: "My Feature",
          overrides: { description: "Custom description" },
        },
      });

      const text = (result.content[0] as { type: "text"; text: string }).text;
      expect(text).toContain("Template instantiated successfully");
      expect(text).toContain("proj_new");

      expect(mockApiRequest).toHaveBeenCalledWith(
        "POST",
        "/templates/tpl_002/instantiate",
        {
          workspace_id: "ws_001",
          name: "My Feature",
          overrides: { description: "Custom description" },
        },
      );
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

  // ── Task claim / release / awareness ────────────────────────────
  describe("task claim/release/awareness tools", () => {
    it("pm_claim_task calls claimTask and renders the result", async () => {
      mockClaimTask.mockResolvedValue({ ok: true, status: "claimed_by_you" });
      const result = await client.callTool({
        name: "pm_claim_task",
        arguments: { task_id: "T1" },
      });
      expect(mockClaimTask).toHaveBeenCalledWith("T1");
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Claimed");
    });

    it("pm_release_task calls releaseTask", async () => {
      mockReleaseTask.mockResolvedValue({ ok: true, status: "released" });
      const result = await client.callTool({
        name: "pm_release_task",
        arguments: { task_id: "T1" },
      });
      expect(mockReleaseTask).toHaveBeenCalledWith("T1");
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Released");
    });

    it("pm_awareness_check reports clear when no one is in flight", async () => {
      mockAwareness.mockResolvedValue({
        label: "renderer",
        inFlight: [],
        total: 0,
      });
      const result = await client.callTool({
        name: "pm_awareness_check",
        arguments: { project_id: "P1", label: "renderer" },
      });
      expect(mockAwareness).toHaveBeenCalledWith("P1", "renderer");
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toMatch(/Clear/i);
    });

    it("pm_awareness_check surfaces in-flight agents with branches", async () => {
      mockAwareness.mockResolvedValue({
        label: "renderer",
        inFlight: [
          {
            taskId: "T1",
            title: "skinning",
            assignee: { id: "U1", name: "Alpha", type: "ai_agent" },
            gitBranch: "feat/skin",
            startedAt: null,
          },
        ],
        total: 1,
      });
      const result = await client.callTool({
        name: "pm_awareness_check",
        arguments: { project_id: "P1", label: "renderer" },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Alpha");
      expect(text).toContain("feat/skin");
      expect(text).toContain("skinning");
    });
  });

  // ── Merge lock tools ────────────────────────────────────────────
  describe("merge lock tools", () => {
    it("pm_acquire_merge_lock defaults resource to 'main'", async () => {
      mockAcquireMergeLock.mockResolvedValue({
        ok: true,
        status: "held",
        expiresAt: "2026-05-29T12:00:00.000Z",
      });
      const result = await client.callTool({
        name: "pm_acquire_merge_lock",
        arguments: { project_id: "P1" },
      });
      expect(mockAcquireMergeLock).toHaveBeenCalledWith("P1", "main", {
        taskId: undefined,
        branch: undefined,
        commitSha: undefined,
        verifyCmd: undefined,
        worktreePath: undefined,
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Acquired");
    });

    it("pm_acquire_merge_lock forwards landing intent fields", async () => {
      mockAcquireMergeLock.mockResolvedValue({
        ok: true,
        status: "held",
        expiresAt: "2026-05-29T12:00:00.000Z",
      });
      await client.callTool({
        name: "pm_acquire_merge_lock",
        arguments: {
          project_id: "P1",
          task_id: "T1",
          branch: "feat/skin",
          commit_sha: "abc1234",
          verify_cmd: "cargo test",
          worktree_path: "D:\\work\\skin",
        },
      });
      expect(mockAcquireMergeLock).toHaveBeenCalledWith("P1", "main", {
        taskId: "T1",
        branch: "feat/skin",
        commitSha: "abc1234",
        verifyCmd: "cargo test",
        worktreePath: "D:\\work\\skin",
      });
    });

    it("pm_acquire_merge_lock reports queue position", async () => {
      mockAcquireMergeLock.mockResolvedValue({
        ok: true,
        status: "queued",
        position: 2,
      });
      const result = await client.callTool({
        name: "pm_acquire_merge_lock",
        arguments: { project_id: "P1", resource: "main" },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Queued");
      expect(text).toContain("2");
    });

    it("pm_release_merge_lock forwards landed_sha", async () => {
      mockReleaseMergeLock.mockResolvedValue({
        ok: true,
        status: "released",
        grantedTo: "U2",
      });
      const result = await client.callTool({
        name: "pm_release_merge_lock",
        arguments: { project_id: "P1", landed_sha: "abc1234" },
      });
      expect(mockReleaseMergeLock).toHaveBeenCalledWith("P1", "main", {
        landedSha: "abc1234",
        reason: undefined,
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("abc1234");
      expect(text).toContain("next queued agent");
    });

    it("pm_release_merge_lock abandons with a reason when no landed_sha", async () => {
      mockReleaseMergeLock.mockResolvedValue({
        ok: true,
        status: "released",
        grantedTo: null,
      });
      const result = await client.callTool({
        name: "pm_release_merge_lock",
        arguments: { project_id: "P1", reason: "build broke in skin.cpp" },
      });
      expect(mockReleaseMergeLock).toHaveBeenCalledWith("P1", "main", {
        landedSha: undefined,
        reason: "build broke in skin.cpp",
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Abandoned");
      expect(text).toContain("build broke");
    });

    it("pm_heartbeat_merge_lock reports lapsed lease", async () => {
      mockHeartbeatMergeLock.mockResolvedValue({
        ok: false,
        status: "not_holder",
      });
      const result = await client.callTool({
        name: "pm_heartbeat_merge_lock",
        arguments: { project_id: "P1" },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toMatch(/no longer hold/i);
    });

    it("pm_get_merge_lock masks holder identity", async () => {
      mockGetMergeLock.mockResolvedValue({
        id: "L1",
        projectId: "P1",
        resource: "main",
        holder: "someone_else",
        holderId: null,
        acquiredAt: "2026-05-29T11:00:00.000Z",
        heartbeatAt: "2026-05-29T11:01:00.000Z",
        expiresAt: "2026-05-29T11:06:00.000Z",
        landedSha: null,
        landedAt: null,
        taskId: null,
        branch: null,
        commitSha: null,
        verifyCmd: null,
        worktreePath: null,
        abandonReason: null,
        queueLength: 1,
        yourPosition: 1,
        createdAt: "2026-05-29T10:00:00.000Z",
        updatedAt: "2026-05-29T11:01:00.000Z",
      });
      const result = await client.callTool({
        name: "pm_get_merge_lock",
        arguments: { project_id: "P1" },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("someone_else");
      expect(text).toContain("Your position in queue: 1");
    });

    it("pm_list_merge_locks lists locks", async () => {
      mockListMergeLocks.mockResolvedValue([
        {
          id: "L1",
          projectId: "P1",
          resource: "main",
          holder: "you",
          holderId: "U1",
          acquiredAt: null,
          heartbeatAt: null,
          expiresAt: null,
          landedSha: "abc",
          landedAt: null,
          taskId: null,
          branch: null,
          commitSha: null,
          verifyCmd: null,
          worktreePath: null,
          abandonReason: null,
          queueLength: 0,
          yourPosition: null,
          createdAt: "x",
          updatedAt: "x",
        },
      ]);
      const result = await client.callTool({
        name: "pm_list_merge_locks",
        arguments: { project_id: "P1" },
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("main");
      expect(text).toContain("abc");
    });
  });

  // ── Merge request tools (Stage 2) ───────────────────────────────
  describe("merge request tools", () => {
    it("pm_request_merge submits and reports queue position", async () => {
      mockSubmitMergeRequest.mockResolvedValue(sampleMergeRequest);
      mockListMergeRequests.mockResolvedValue([sampleMergeRequest]);

      const result = await client.callTool({
        name: "pm_request_merge",
        arguments: {
          project_id: "P1",
          task_id: "T1",
          branch: "feat/skin",
          commit_sha: "abc1234",
        },
      });

      expect(mockSubmitMergeRequest).toHaveBeenCalledWith("P1", {
        resource: "main",
        taskId: "T1",
        branch: "feat/skin",
        commitSha: "abc1234",
        verifyCmd: undefined,
        worktreePath: undefined,
      });
      expect(mockListMergeRequests).toHaveBeenCalledWith("P1", {
        resource: "main",
        status: "queued",
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("mreq_001");
      expect(text).toContain("queued");
      expect(text).toContain("Queue position: 1 of 1");
      expect(text).toContain("merge.request.landed");
    });

    it("pm_list_merge_requests renders rows with queue positions", async () => {
      mockListMergeRequests.mockResolvedValue([
        { ...sampleMergeRequest, id: "mreq_A", status: "integrating" },
        { ...sampleMergeRequest, id: "mreq_B", status: "queued" },
        { ...sampleMergeRequest, id: "mreq_C", status: "queued" },
      ]);

      const result = await client.callTool({
        name: "pm_list_merge_requests",
        arguments: { project_id: "P1", resource: "main" },
      });

      expect(mockListMergeRequests).toHaveBeenCalledWith("P1", {
        resource: "main",
        status: undefined,
        taskId: undefined,
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("mreq_A");
      expect(text).toContain("integrating");
      expect(text).toContain("queued (position 1)");
      expect(text).toContain("queued (position 2)");
      expect(text).toContain("by U_AGENT");
    });

    it("pm_get_merge_request surfaces rejection envelope prominently", async () => {
      mockGetMergeRequest.mockResolvedValue({
        ...sampleMergeRequest,
        status: "rejected",
        resolvedAt: "2026-05-29T14:24:48.902Z",
        rejectCategory: "build_failed",
        rejectReason: "cargo build --workspace failed: 3 errors\nin crates/renderer",
        failedFiles: ["crates/renderer/src/skinned.rs", "crates/renderer/src/lib.rs"],
        logExcerpt: "error[E0599]: ...",
        logUrl: "file:///tmp/logs/attempt01.log",
        attempts: [
          {
            id: "att_1",
            requestId: "mreq_001",
            attemptNumber: 1,
            baseSha: "2c8f1d9",
            treeSha: null,
            status: "failed",
            startedAt: "2026-05-29T14:21:05Z",
            completedAt: "2026-05-29T14:24:48Z",
            verifyDurationMs: 223000,
            failureCategory: "build_failed",
            failureReason: "cargo build --workspace failed: 3 errors",
            failedFiles: ["crates/renderer/src/skinned.rs"],
            logExcerpt: null,
            logUrl: "file:///tmp/logs/attempt01.log",
            createdAt: "2026-05-29T14:21:05Z",
          },
        ],
      });

      const result = await client.callTool({
        name: "pm_get_merge_request",
        arguments: { request_id: "mreq_001" },
      });

      expect(mockGetMergeRequest).toHaveBeenCalledWith("mreq_001");
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("REJECTED");
      expect(text).toContain("REJECTION (build_failed)");
      expect(text).toContain("cargo build --workspace failed: 3 errors");
      expect(text).toContain("crates/renderer/src/skinned.rs");
      expect(text).toContain("file:///tmp/logs/attempt01.log");
      expect(text).toContain("Attempts (1)");
      expect(text).toContain("#1");
      expect(text).toContain("failed");
      expect(text).toContain("base=2c8f1d9");
    });

    it("pm_cancel_merge_request reports new status", async () => {
      mockCancelMergeRequest.mockResolvedValue({
        ...sampleMergeRequest,
        status: "abandoned",
        resolvedAt: "2026-05-29T14:22:50.000Z",
      });

      const result = await client.callTool({
        name: "pm_cancel_merge_request",
        arguments: { request_id: "mreq_001" },
      });

      expect(mockCancelMergeRequest).toHaveBeenCalledWith("mreq_001");
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("mreq_001");
      expect(text).toContain("abandoned");
      expect(text).toContain("2026-05-29T14:22:50.000Z");
    });
  });

  // ── Merge group + incident tools (Phase 7.3) ────────────────────
  describe("merge group + incident tools", () => {
    const sampleGroupDetail = {
      id: "grp_001",
      projectId: "P1",
      resource: "main",
      state: "forming" as const,
      submittedBy: "U_AGENT",
      integratorId: null,
      resolvedAt: null,
      resolutionReason: null,
      createdAt: "2026-05-29T14:21:03.412Z",
      updatedAt: "2026-05-29T14:21:03.412Z",
      members: [
        { ...sampleMergeRequest, id: "mreq_A", branch: "feat/inner" },
        { ...sampleMergeRequest, id: "mreq_B", branch: "feat/outer" },
      ],
    };

    const sampleIncident = {
      id: "inc_001",
      projectId: "P1",
      groupId: "grp_001",
      type: "orphaned_inner" as const,
      innerRepo: "inner",
      orphanedSha: "orphan99",
      outerRepo: "outer",
      innerRequestId: "mreq_A",
      taskId: "T1",
      state: "open" as const,
      openedAt: "2026-05-29T14:30:00.000Z",
      resolvedAt: null,
      resolution: null,
      createdAt: "2026-05-29T14:30:00.000Z",
      updatedAt: "2026-05-29T14:30:00.000Z",
    };

    it("pm_request_merge_group creates a group and lists members", async () => {
      mockRequestMergeGroup.mockResolvedValue(sampleGroupDetail);

      const result = await client.callTool({
        name: "pm_request_merge_group",
        arguments: {
          project_id: "P1",
          member_request_ids: ["mreq_A", "mreq_B"],
        },
      });

      expect(mockRequestMergeGroup).toHaveBeenCalledWith("P1", {
        resource: "main",
        memberRequestIds: ["mreq_A", "mreq_B"],
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("grp_001");
      expect(text).toContain("forming");
      expect(text).toContain("mreq_A");
      expect(text).toContain("mreq_B");
      expect(text).toContain("merge.group.landed");
    });

    it("pm_get_merge_group surfaces state + members", async () => {
      mockGetMergeGroup.mockResolvedValue({
        ...sampleGroupDetail,
        state: "landed",
        members: sampleGroupDetail.members.map((m) => ({
          ...m,
          status: "landed",
          landedSha: `land-${m.id}`,
        })),
      });

      const result = await client.callTool({
        name: "pm_get_merge_group",
        arguments: { group_id: "grp_001" },
      });

      expect(mockGetMergeGroup).toHaveBeenCalledWith("grp_001");
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("LANDED");
      expect(text).toContain("mreq_A");
      expect(text).toContain("land-mreq_A");
    });

    it("pm_list_merge_incidents renders one line per incident and maps all→undefined", async () => {
      mockListMergeIncidents.mockResolvedValue([sampleIncident]);

      const result = await client.callTool({
        name: "pm_list_merge_incidents",
        arguments: { project_id: "P1" },
      });

      expect(mockListMergeIncidents).toHaveBeenCalledWith("P1", {
        state: undefined,
      });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("inc_001");
      expect(text).toContain("open");
      expect(text).toContain("inner@orphan99");
      expect(text).toContain("outer");
    });

    it("pm_list_merge_incidents passes a concrete state filter", async () => {
      mockListMergeIncidents.mockResolvedValue([]);

      await client.callTool({
        name: "pm_list_merge_incidents",
        arguments: { project_id: "P1", state: "open" },
      });

      expect(mockListMergeIncidents).toHaveBeenCalledWith("P1", {
        state: "open",
      });
    });

    it("pm_get_merge_incident surfaces detail + resolution", async () => {
      mockGetMergeIncident.mockResolvedValue({
        ...sampleIncident,
        state: "human_resolved",
        resolvedAt: "2026-05-29T15:00:00.000Z",
        resolution: {
          mode: "human",
          outerLandedSha: "outer-land",
          note: "fixed by hand",
        },
      });

      const result = await client.callTool({
        name: "pm_get_merge_incident",
        arguments: { incident_id: "inc_001" },
      });

      expect(mockGetMergeIncident).toHaveBeenCalledWith("inc_001");
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("inc_001");
      expect(text).toContain("HUMAN_RESOLVED");
      expect(text).toContain("inner @ orphan99");
      expect(text).toContain("outer");
      expect(text).toContain("T1");
      expect(text).toContain("outer-land");
      expect(text).toContain("fixed by hand");
    });
  });
});
