import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestApp,
  createTestProject,
  createTestAiAgent,
  authRequest,
  type TestApp,
} from "../utils.js";

// ─── SSE parsing helpers (mirrors events.test.ts) ────────────────

function parseSSEEvents(text: string): Array<{ event?: string; data?: string }> {
  const events: Array<{ event?: string; data?: string }> = [];
  const blocks = text.split(/\r?\n\r?\n/).filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const entry: { event?: string; data?: string } = {};
    for (const line of lines) {
      if (line.startsWith("event: ")) entry.event = line.slice(7);
      else if (line.startsWith("data: ")) entry.data = line.slice(6);
      else if (line.startsWith("data:")) entry.data = line.slice(5);
    }
    if (entry.event || entry.data) events.push(entry);
  }
  return events;
}

async function readSSEStream(
  response: Response,
  opts: { maxEvents?: number; timeoutMs?: number } = {},
): Promise<string> {
  const { maxEvents = 5, timeoutMs = 2000 } = opts;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const timeout = new Promise<void>((resolve) => setTimeout(() => resolve(), timeoutMs));
  const read = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (parseSSEEvents(text).length >= maxEvents) break;
      }
    } catch {
      /* reader may be cancelled */
    }
  };
  await Promise.race([read(), timeout]);
  try {
    reader.cancel();
  } catch {
    /* already closed */
  }
  return text;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Merge batch relay endpoint", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  // ── Auth ─────────────────────────────────────────────────────

  it("returns 403 FORBIDDEN for a non-ai_agent (human/admin) caller", async () => {
    const project = createTestProject(testApp.db);
    const res = await authRequest(
      testApp.app,
      "POST",
      `/api/v1/projects/${project.id}/merge-batches/events`,
      {
        body: {
          type: "started",
          batchId: "batch-1",
          resource: "main",
          memberCount: 0,
          memberRequestIds: [],
        },
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 401 with no token", async () => {
    const project = createTestProject(testApp.db);
    const res = await testApp.app.request(`/api/v1/projects/${project.id}/merge-batches/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "started",
        batchId: "batch-1",
        resource: "main",
        memberCount: 0,
        memberRequestIds: [],
      }),
    });
    expect(res.status).toBe(401);
  });

  // ── Re-emit each of the 4 markers over SSE ────────────────────

  type Marker = Record<string, unknown> & { type: string };

  const cases: Array<{
    name: string;
    sseEvent: string;
    marker: Marker;
    assertExtra?: (data: Record<string, unknown>) => void;
  }> = [
    {
      name: "started",
      sseEvent: "merge.batch.started",
      marker: {
        type: "started",
        batchId: "batch-S",
        resource: "main",
        memberCount: 2,
        memberRequestIds: ["r1", "r2"],
      },
    },
    {
      name: "member_landed",
      sseEvent: "merge.batch.member_landed",
      marker: {
        type: "member_landed",
        batchId: "batch-L",
        requestId: "r1",
        speculativePosition: 0,
        landedSha: "sha000",
      },
      assertExtra: (data) => {
        expect(data.speculative_position).toBe(0);
      },
    },
    {
      name: "member_invalidated",
      sseEvent: "merge.batch.member_invalidated",
      marker: {
        type: "member_invalidated",
        batchId: "batch-I",
        requestId: "r2",
        speculativePosition: 1,
        reason: "predecessor r1 failed",
        failedPredecessorRequestId: "r1",
      },
      assertExtra: (data) => {
        expect(data.speculative_position).toBe(1);
      },
    },
    {
      name: "completed",
      sseEvent: "merge.batch.completed",
      marker: {
        type: "completed",
        batchId: "batch-C",
        landed: 1,
        rejected: 1,
        invalidated: 0,
      },
    },
  ];

  for (const tc of cases) {
    it(`re-emits ${tc.name} over SSE with entity_type=merge_batch and batch_id`, async () => {
      const project = createTestProject(testApp.db);
      const agent = createTestAiAgent(testApp.db);

      const sseRes = await authRequest(
        testApp.app,
        "GET",
        `/api/v1/events?project_id=${project.id}`,
      );
      expect(sseRes.status).toBe(200);

      setTimeout(async () => {
        const res = await authRequest(
          testApp.app,
          "POST",
          `/api/v1/projects/${project.id}/merge-batches/events`,
          { token: agent.token, body: tc.marker },
        );
        expect(res.status).toBe(202);
        const accepted = await res.json();
        expect(accepted.data.ok).toBe(true);
      }, 50);

      const text = await readSSEStream(sseRes, { maxEvents: 2, timeoutMs: 2000 });
      const events = parseSSEEvents(text);

      const evt = events.find((e) => e.event === tc.sseEvent);
      expect(evt).toBeDefined();
      const data = JSON.parse(evt!.data!);
      expect(data.entity_type).toBe("merge_batch");
      expect(data.batch_id).toBe(tc.marker.batchId);
      expect(data.entity_id).toBe(tc.marker.batchId);
      if (tc.assertExtra) tc.assertExtra(data);
    });
  }
});
