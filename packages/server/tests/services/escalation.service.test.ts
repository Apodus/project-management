import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@pm/shared";
import {
  createTestApp,
  createTestProject,
  createTestUser,
  type TestApp,
} from "../utils.js";
import { escalations, escalationMessages, getRawDb } from "../../src/db/index.js";
import { AppError } from "../../src/types.js";
import { EVENT_NAMES, getEventBus } from "../../src/events/event-bus.js";
import * as escalationService from "../../src/services/escalation.service.js";

// ──────────────────────────────────────────────────────────────────
// Campaign C1 (escalation channel §P2): the escalation service —
// lifecycle (open→acknowledged→answered→resolved + needs_human),
// centralized transition guard, atomic per-thread seq, and the
// authz-before-mutation matrix (incl. Amendments A + B).
// ──────────────────────────────────────────────────────────────────

const ORIGIN = { originRepo: "game_one", originWorkerKey: "worker-7" };

function raise(
  db: TestApp["db"],
  projectId: string,
  actor: { id: string; type: "human" | "ai_agent" },
  overrides: Partial<{ kind: "bug_report" | "question" | "request" | "blocked"; title: string }> = {},
) {
  return escalationService.create(
    projectId,
    {
      kind: overrides.kind ?? "bug_report",
      title: overrides.title ?? "Build is red",
      ...ORIGIN,
    },
    actor,
  );
}

describe("escalation service", () => {
  let testApp: TestApp;

  beforeEach(() => {
    testApp = createTestApp();
  });

  afterEach(() => {
    testApp.cleanup();
  });

  function agent() {
    return createTestUser(testApp.db, { type: "ai_agent" });
  }
  function human() {
    return createTestUser(testApp.db, { type: "human" });
  }
  function actorOf(u: { id: string; type: string }) {
    return { id: u.id, type: u.type as "human" | "ai_agent" };
  }

  // ── create ──────────────────────────────────────────────────────
  describe("create", () => {
    it("creates an open escalation authored by the caller, origin persisted", () => {
      const project = createTestProject(testApp.db);
      const author = agent();

      const esc = raise(testApp.db, project.id, actorOf(author));

      expect(esc.id).toBeTruthy();
      expect(esc.status).toBe("open");
      expect(esc.kind).toBe("bug_report");
      expect(esc.authorId).toBe(author.id);
      expect(esc.holderId).toBeNull();
      expect(esc.originRepo).toBe("game_one");
      expect(esc.originWorkerKey).toBe("worker-7");
      expect(esc.projectId).toBe(project.id);
    });

    it("throws 404 when the project does not exist", () => {
      const author = agent();
      try {
        raise(testApp.db, createId(), actorOf(author));
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
      }
    });
  });

  // ── happy path ──────────────────────────────────────────────────
  describe("legal lifecycle", () => {
    it("open→acknowledge→answer→resolve; resolve stamps resolvedAt/resolvedBy", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const holder = human();

      const esc = raise(testApp.db, project.id, actorOf(author));
      const ack = escalationService.acknowledge(esc.id, actorOf(holder));
      expect(ack.status).toBe("acknowledged");
      expect(ack.holderId).toBeNull(); // human ack does NOT auto-claim

      const answered = escalationService.answer(esc.id, { body: "Root cause: X" }, actorOf(holder));
      expect(answered.status).toBe("answered");
      expect(answered.holderId).toBe(holder.id); // self-claim-on-answer (unheld → answerer)

      const resolved = escalationService.resolve(esc.id, { reason: "shipped fix" }, actorOf(holder));
      expect(resolved.status).toBe("resolved");
      expect(resolved.resolvedAt).toBeTruthy();
      expect(resolved.resolvedBy).toBe(holder.id);
    });
  });

  // ── illegal transitions → 409 ───────────────────────────────────
  describe("illegal transitions (409)", () => {
    function expect409(fn: () => void) {
      try {
        fn();
        expect.unreachable("should have thrown 409");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(409);
      }
    }

    it("resolve from open by a non-author holder → 409", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const holder = human();
      const esc = raise(testApp.db, project.id, actorOf(author));
      // holder is human (passes authz) but non-author → baseline transition rules → 409 from open.
      expect409(() => escalationService.resolve(esc.id, { reason: "no" }, actorOf(holder)));
    });

    it("answer from open → 409", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const esc = raise(testApp.db, project.id, actorOf(author));
      expect409(() => escalationService.answer(esc.id, {}, actorOf(human())));
    });

    it("acknowledge a resolved escalation → 409", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const h = human();
      const esc = raise(testApp.db, project.id, actorOf(author));
      escalationService.acknowledge(esc.id, actorOf(h));
      escalationService.answer(esc.id, {}, actorOf(h));
      escalationService.resolve(esc.id, { reason: "done" }, actorOf(h));
      expect409(() => escalationService.acknowledge(esc.id, actorOf(h)));
    });

    it("addMessage on a resolved escalation → 409 (append-frozen)", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const h = human();
      const esc = raise(testApp.db, project.id, actorOf(author));
      escalationService.acknowledge(esc.id, actorOf(h));
      escalationService.answer(esc.id, {}, actorOf(h));
      escalationService.resolve(esc.id, { reason: "done" }, actorOf(h));
      expect409(() => escalationService.addMessage(esc.id, { body: "late" }, actorOf(h)));
    });

    it("double-resolve → 409", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const h = human();
      const esc = raise(testApp.db, project.id, actorOf(author));
      escalationService.acknowledge(esc.id, actorOf(h));
      escalationService.answer(esc.id, {}, actorOf(h));
      escalationService.resolve(esc.id, { reason: "done" }, actorOf(h));
      expect409(() => escalationService.resolve(esc.id, { reason: "again" }, actorOf(h)));
    });
  });

  // ── AMENDMENT A — answer self-claims ─────────────────────────────
  describe("Amendment A — answer self-claims an unclaimed thread", () => {
    it("a human acknowledges (holder stays null) → an ai_agent can still answer (self-claims)", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const reviewer = human();
      const responder = agent();

      const esc = raise(testApp.db, project.id, actorOf(author));
      const ack = escalationService.acknowledge(esc.id, actorOf(reviewer));
      expect(ack.holderId).toBeNull(); // human ack does NOT auto-claim

      const answered = escalationService.answer(esc.id, { body: "found it" }, actorOf(responder));
      expect(answered.status).toBe("answered");
      expect(answered.holderId).toBe(responder.id); // self-claim-on-answer
    });

    it("an unclaimed acknowledged escalation: agent answer self-claims even without prior agent ack", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const reviewer = human();
      const responder = agent();

      const esc = raise(testApp.db, project.id, actorOf(author));
      escalationService.acknowledge(esc.id, actorOf(reviewer)); // holder null
      const answered = escalationService.answer(esc.id, {}, actorOf(responder));
      expect(answered.holderId).toBe(responder.id);
    });
  });

  // ── AMENDMENT B — author withdrawal ──────────────────────────────
  describe("Amendment B — author withdrawal", () => {
    it("origin author resolves from open → ok; system message notes withdrawn", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const esc = raise(testApp.db, project.id, actorOf(author));

      const resolved = escalationService.resolve(esc.id, { reason: "never mind" }, actorOf(author));
      expect(resolved.status).toBe("resolved");
      expect(resolved.resolvedBy).toBe(author.id);

      const full = escalationService.getById(esc.id);
      const sys = full.messages.find((m) => m.messageType === "system");
      expect(sys?.body).toContain("(withdrawn by author)");
      expect(sys?.body).toContain("never mind");
    });

    it("a non-author human resolving from open → 409", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const other = human();
      const esc = raise(testApp.db, project.id, actorOf(author));
      try {
        escalationService.resolve(esc.id, { reason: "no" }, actorOf(other));
        expect.unreachable("should have thrown 409");
      } catch (err) {
        expect((err as AppError).statusCode).toBe(409);
      }
    });
  });

  // ── authz matrix ─────────────────────────────────────────────────
  describe("authz matrix (403 before mutation)", () => {
    function expect403(fn: () => void) {
      try {
        fn();
        expect.unreachable("should have thrown 403");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(403);
      }
    }

    it("reply by an unrelated agent → 403; by author/holder/human → ok", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const holder = agent();
      const stranger = agent();
      const esc = raise(testApp.db, project.id, actorOf(author));
      // Human acknowledges (no auto-claim), then the agent answers → becomes holder.
      escalationService.acknowledge(esc.id, actorOf(human()));
      escalationService.answer(esc.id, {}, actorOf(holder));

      expect403(() => escalationService.addMessage(esc.id, { body: "x" }, actorOf(stranger)));
      expect(escalationService.addMessage(esc.id, { body: "a" }, actorOf(author)).id).toBeTruthy();
      expect(escalationService.addMessage(esc.id, { body: "h" }, actorOf(holder)).id).toBeTruthy();
      expect(escalationService.addMessage(esc.id, { body: "m" }, actorOf(human())).id).toBeTruthy();
    });

    it("acknowledge by author or stranger agent → 403; by holder/human → ok", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const esc = raise(testApp.db, project.id, actorOf(author));
      // author is an ai_agent and not the holder (null) → 403.
      expect403(() => escalationService.acknowledge(esc.id, actorOf(author)));
      expect403(() => escalationService.acknowledge(esc.id, actorOf(agent())));
      // human → ok.
      expect(escalationService.acknowledge(esc.id, actorOf(human())).status).toBe("acknowledged");
    });

    it("answer by an author who is NOT holder when holder already set → 403", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const holder = agent();
      const esc = raise(testApp.db, project.id, actorOf(author));
      // Human acknowledges, then bind the holder to the agent directly (the
      // acknowledged-with-a-set-holder state — reachable only by binding,
      // since agent auto-claim on ack is chicken-and-egg).
      escalationService.acknowledge(esc.id, actorOf(human()));
      testApp.db
        .update(escalations)
        .set({ holderId: holder.id })
        .where(eq(escalations.id, esc.id))
        .run();
      // author is an ai_agent, not the holder, holder set → 403.
      expect403(() => escalationService.answer(esc.id, {}, actorOf(author)));
      // holder → ok.
      expect(escalationService.answer(esc.id, {}, actorOf(holder)).status).toBe("answered");
    });

    it("resolve by an unrelated agent → 403 (before any 409 status check)", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const esc = raise(testApp.db, project.id, actorOf(author));
      // open escalation, stranger agent → must be 403 (authz), not 409 (status).
      expect403(() => escalationService.resolve(esc.id, { reason: "x" }, actorOf(agent())));
    });

    it("escalateToHuman by an unrelated agent → 403", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const esc = raise(testApp.db, project.id, actorOf(author));
      expect403(() => escalationService.escalateToHuman(esc.id, { reason: "x" }, actorOf(agent())));
      // author → ok.
      const escalated = escalationService.escalateToHuman(esc.id, { reason: "need human" }, actorOf(author));
      expect(escalated.status).toBe("needs_human");
    });
  });

  // ── seq monotonicity + thread ordering ───────────────────────────
  describe("thread seq", () => {
    it("3 sequential addMessage → seq 1,2,3; getById ordered by seq", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const esc = raise(testApp.db, project.id, actorOf(author));
      escalationService.addMessage(esc.id, { body: "one" }, actorOf(author));
      escalationService.addMessage(esc.id, { body: "two" }, actorOf(author));
      escalationService.addMessage(esc.id, { body: "three" }, actorOf(author));

      const full = escalationService.getById(esc.id);
      expect(full.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
      expect(full.messages.map((m) => m.body)).toEqual(["one", "two", "three"]);
    });

    it("a raw duplicate (escalationId, seq) insert throws (unique backstop)", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const esc = raise(testApp.db, project.id, actorOf(author));
      escalationService.addMessage(esc.id, { body: "one" }, actorOf(author));

      testApp.db
        .insert(escalationMessages)
        .values({
          id: createId(),
          escalationId: esc.id,
          seq: 99,
          authorId: author.id,
          body: "manual",
          messageType: null,
          metadata: null,
          createdAt: new Date().toISOString(),
        })
        .run();

      expect(() =>
        testApp.db
          .insert(escalationMessages)
          .values({
            id: createId(),
            escalationId: esc.id,
            seq: 99,
            authorId: author.id,
            body: "dup",
            messageType: null,
            metadata: null,
            createdAt: new Date().toISOString(),
          })
          .run(),
      ).toThrow();

      // Sanity: the unique index exists on (escalation_id, seq).
      const idx = getRawDb()
        .prepare("PRAGMA index_list('escalation_messages')")
        .all() as Array<{ name: string; unique: number }>;
      expect(idx.some((i) => i.unique === 1)).toBe(true);
    });
  });

  // ── cross-project isolation ──────────────────────────────────────
  describe("cross-project isolation", () => {
    it("list(projectA) excludes project B's escalations", () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      const author = agent();
      const a = raise(testApp.db, projectA.id, actorOf(author), { title: "A-side" });
      raise(testApp.db, projectB.id, actorOf(author), { title: "B-side" });

      const listed = escalationService.list(projectA.id, {});
      expect(listed.map((e) => e.id)).toEqual([a.id]);
    });
  });

  // ── events ───────────────────────────────────────────────────────
  describe("events", () => {
    it("each transition emits its event name with entityType escalation", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const holder = agent();

      const seen: string[] = [];
      const names = [
        EVENT_NAMES.ESCALATION_OPENED,
        EVENT_NAMES.ESCALATION_ACKNOWLEDGED,
        EVENT_NAMES.ESCALATION_REPLIED,
        EVENT_NAMES.ESCALATION_ANSWERED,
        EVENT_NAMES.ESCALATION_RESOLVED,
      ];
      for (const n of names) {
        getEventBus().on(n, (p) => {
          expect(p.entityType).toBe("escalation");
          seen.push(n);
        });
      }

      const esc = raise(testApp.db, project.id, actorOf(author));
      escalationService.acknowledge(esc.id, actorOf(human()));
      escalationService.addMessage(esc.id, { body: "progress" }, actorOf(author));
      escalationService.answer(esc.id, {}, actorOf(holder)); // self-claims
      escalationService.resolve(esc.id, { reason: "done" }, actorOf(holder));

      expect(seen).toEqual([
        EVENT_NAMES.ESCALATION_OPENED,
        EVENT_NAMES.ESCALATION_ACKNOWLEDGED,
        EVENT_NAMES.ESCALATION_REPLIED,
        EVENT_NAMES.ESCALATION_ANSWERED,
        EVENT_NAMES.ESCALATION_RESOLVED,
      ]);
    });

    it("escalateToHuman emits needs_human", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const esc = raise(testApp.db, project.id, actorOf(author));

      let fired = false;
      getEventBus().on(EVENT_NAMES.ESCALATION_NEEDS_HUMAN, (p) => {
        expect(p.entityType).toBe("escalation");
        fired = true;
      });
      escalationService.escalateToHuman(esc.id, { reason: "need a human" }, actorOf(author));
      expect(fired).toBe(true);
    });
  });
});
