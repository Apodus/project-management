import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  ).escalation;
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

  // ── C3 autonomous-responder pickup path (regression) ─────────────
  describe("autonomous responder pickup (acknowledge is PM pickup)", () => {
    it("an ai_agent can pick up (acknowledge) an unclaimed open escalation then answer it", () => {
      // Regression for the C1 P2 lifecycle dead-end: the acknowledge gate
      // rejected any ai_agent on an unclaimed (holderId null) escalation, so
      // the C3 autonomous responder could neither acknowledge nor (via the
      // status guard) answer an open escalation. Full C3-style flow:
      const project = createTestProject(testApp.db);
      const author = agent();
      const responder = agent();

      const esc = raise(testApp.db, project.id, actorOf(author));
      expect(esc.status).toBe("open");
      expect(esc.holderId).toBeNull();

      // raise → ai_agent acknowledge (claims, →acknowledged)
      const acked = escalationService.acknowledge(esc.id, actorOf(responder));
      expect(acked.status).toBe("acknowledged");
      expect(acked.holderId).toBe(responder.id);

      // same ai_agent answer (→answered)
      const answered = escalationService.answer(esc.id, { body: "fixed it" }, actorOf(responder));
      expect(answered.status).toBe("answered");
      expect(answered.holderId).toBe(responder.id);

      // resolve
      const resolved = escalationService.resolve(esc.id, { reason: "shipped" }, actorOf(responder));
      expect(resolved.status).toBe("resolved");
      expect(resolved.resolvedBy).toBe(responder.id);
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

    it("acknowledge is PM pickup: unclaimed open is acknowledgeable by any PM actor; a 2nd agent on a held thread → 403", () => {
      // An unclaimed (holderId null) open escalation is open for pickup by
      // ANY PM actor — an ai_agent picking it up auto-claims; a human ack does
      // not claim. The real "other-agent" rejection is a DIFFERENT agent
      // acknowledging a thread an agent already holds.
      const project = createTestProject(testApp.db);
      const author = agent();

      // (a) ai_agent acknowledges an unclaimed open escalation → succeeds + claims.
      const escA = raise(testApp.db, project.id, actorOf(author));
      const agentA = agent();
      const ackedA = escalationService.acknowledge(escA.id, actorOf(agentA));
      expect(ackedA.status).toBe("acknowledged");
      expect(ackedA.holderId).toBe(agentA.id); // auto-claim on pickup

      // (b) a DIFFERENT agent acknowledging the now-held thread → 403.
      const agentB = agent();
      expect403(() => escalationService.acknowledge(escA.id, actorOf(agentB)));

      // (c) a human acknowledging an unclaimed open escalation → succeeds, holder stays null.
      const escB = raise(testApp.db, project.id, actorOf(author));
      const ackedB = escalationService.acknowledge(escB.id, actorOf(human()));
      expect(ackedB.status).toBe("acknowledged");
      expect(ackedB.holderId).toBeNull(); // human ack does NOT claim
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

  // ── C2 §P1: delivery cursor ─────────────────────────────────────
  describe("delivery cursor (C2 P1)", () => {
    // Raise as the origin author, then have a holder pick it up and reply,
    // so there is a non-origin-authored directed reply for the origin to see.
    function raiseWithHolderReply(
      projectId: string,
      origin: { id: string; type: "human" | "ai_agent" },
      holder: { id: string; type: "human" | "ai_agent" },
      replyBody = "here is your fix",
    ) {
      const esc = raise(testApp.db, projectId, origin);
      escalationService.acknowledge(esc.id, holder); // holder auto-claims if agent
      escalationService.addMessage(esc.id, { body: replyBody }, holder);
      return esc;
    }

    it("listUndeliveredForWorker surfaces a non-origin reply; origin's own message excluded", () => {
      const project = createTestProject(testApp.db);
      const origin = agent();
      const holder = human();
      const esc = raiseWithHolderReply(project.id, actorOf(origin), actorOf(holder));

      // The origin author also posts a message of their own — must be excluded.
      escalationService.addMessage(esc.id, { body: "thanks, looking" }, actorOf(origin));

      const undelivered = escalationService.listUndeliveredForWorker(ORIGIN.originWorkerKey);
      expect(undelivered).toHaveLength(1);
      const entry = undelivered[0];
      expect(entry.escalation.id).toBe(esc.id);
      expect(entry.unreadCount).toBe(1);
      expect(entry.unreadMessages).toHaveLength(1);
      expect(entry.unreadMessages[0].body).toBe("here is your fix");
      expect(entry.unreadMessages[0].authorId).toBe(holder.id);
      // The view shape carries no nested `messages` key (that is getById).
      expect("messages" in entry.escalation).toBe(false);
    });

    it("only counts replies with seq > the cursor", () => {
      const project = createTestProject(testApp.db);
      const origin = agent();
      const holder = human();
      const esc = raiseWithHolderReply(project.id, actorOf(origin), actorOf(holder), "reply one");

      // Cursor at seq 1 → first reply (seq 1) now read; a second reply is unread.
      escalationService.markDelivered(esc.id, 1, ORIGIN.originWorkerKey);
      escalationService.addMessage(esc.id, { body: "reply two" }, actorOf(holder));

      const undelivered = escalationService.listUndeliveredForWorker(ORIGIN.originWorkerKey);
      expect(undelivered).toHaveLength(1);
      expect(undelivered[0].unreadCount).toBe(1);
      expect(undelivered[0].unreadMessages[0].body).toBe("reply two");
    });

    it("escalation with no directed reply is omitted", () => {
      const project = createTestProject(testApp.db);
      const origin = agent();
      // No holder reply — only the origin exists, nothing to deliver.
      raise(testApp.db, project.id, actorOf(origin));

      const undelivered = escalationService.listUndeliveredForWorker(ORIGIN.originWorkerKey);
      expect(undelivered).toHaveLength(0);
    });

    it("isolates by workerKey — a worker sees only its own escalations", () => {
      const project = createTestProject(testApp.db);
      const origin = agent();
      const holder = human();
      raiseWithHolderReply(project.id, actorOf(origin), actorOf(holder));

      const undelivered = escalationService.listUndeliveredForWorker("some-other-worker");
      expect(undelivered).toHaveLength(0);
    });

    it("scopes by projectId when given", () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      const origin = agent();
      const holder = human();
      raiseWithHolderReply(projectA.id, actorOf(origin), actorOf(holder));
      raiseWithHolderReply(projectB.id, actorOf(origin), actorOf(holder));

      const all = escalationService.listUndeliveredForWorker(ORIGIN.originWorkerKey);
      expect(all).toHaveLength(2);
      const scoped = escalationService.listUndeliveredForWorker(ORIGIN.originWorkerKey, projectA.id);
      expect(scoped).toHaveLength(1);
      expect(scoped[0].escalation.projectId).toBe(projectA.id);
    });

    it("markDelivered advances 0 → N, is idempotent, and never decreases", () => {
      const project = createTestProject(testApp.db);
      const origin = agent();
      const holder = human();
      const esc = raiseWithHolderReply(project.id, actorOf(origin), actorOf(holder));

      const row = () =>
        testApp.db.select().from(escalations).where(eq(escalations.id, esc.id)).get()!;
      expect(row().originLastSeenSeq).toBe(0);

      const after = escalationService.markDelivered(esc.id, 1, ORIGIN.originWorkerKey);
      expect(after.originLastSeenSeq).toBe(1);
      expect(row().originLastSeenSeq).toBe(1);

      // Idempotent.
      escalationService.markDelivered(esc.id, 1, ORIGIN.originWorkerKey);
      expect(row().originLastSeenSeq).toBe(1);

      // Never decreases (uptoSeq < current is a no-op).
      escalationService.markDelivered(esc.id, 0, ORIGIN.originWorkerKey);
      expect(row().originLastSeenSeq).toBe(1);

      // Forward to a higher watermark.
      escalationService.markDelivered(esc.id, 5, ORIGIN.originWorkerKey);
      expect(row().originLastSeenSeq).toBe(5);
    });

    it("markDelivered does NOT bump updatedAt", () => {
      const project = createTestProject(testApp.db);
      const origin = agent();
      const holder = human();
      const esc = raiseWithHolderReply(project.id, actorOf(origin), actorOf(holder));
      const before = testApp.db
        .select()
        .from(escalations)
        .where(eq(escalations.id, esc.id))
        .get()!.updatedAt;

      escalationService.markDelivered(esc.id, 1, ORIGIN.originWorkerKey);
      const after = testApp.db
        .select()
        .from(escalations)
        .where(eq(escalations.id, esc.id))
        .get()!.updatedAt;
      expect(after).toBe(before);
    });

    it("markDelivered 403s on a wrong workerKey", () => {
      const project = createTestProject(testApp.db);
      const origin = agent();
      const esc = raise(testApp.db, project.id, actorOf(origin));
      try {
        escalationService.markDelivered(esc.id, 1, "not-the-origin");
        expect.unreachable("should have thrown 403");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(403);
      }
    });

    it("markDelivered 404s on an unknown id", () => {
      try {
        escalationService.markDelivered(createId(), 1, ORIGIN.originWorkerKey);
        expect.unreachable("should have thrown 404");
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(404);
      }
    });

    it("getById does NOT advance the cursor (read path is inert)", () => {
      const project = createTestProject(testApp.db);
      const origin = agent();
      const holder = human();
      const esc = raiseWithHolderReply(project.id, actorOf(origin), actorOf(holder));

      escalationService.getById(esc.id);
      const seq = testApp.db
        .select()
        .from(escalations)
        .where(eq(escalations.id, esc.id))
        .get()!.originLastSeenSeq;
      expect(seq).toBe(0);
    });
  });

  // ── C4 §P4: FTS dedup + strict auto-link ─────────────────────────
  describe("findSimilarOpenEscalations (advisory dedup)", () => {
    function rawRaise(
      projectId: string,
      actor: { id: string; type: "human" | "ai_agent" },
      overrides: Partial<{
        kind: "bug_report" | "question" | "request" | "blocked";
        title: string;
        body: string;
        originRepo: string;
        originWorkerKey: string;
      }> = {},
    ) {
      return escalationService.create(
        projectId,
        {
          kind: overrides.kind ?? "bug_report",
          title: overrides.title ?? "Build is red",
          body: overrides.body,
          originRepo: overrides.originRepo ?? ORIGIN.originRepo,
          originWorkerKey: overrides.originWorkerKey ?? ORIGIN.originWorkerKey,
        },
        actor,
      );
    }

    it("surfaces a near-duplicate OPEN escalation sharing a distinctive title term", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const existing = rawRaise(project.id, actorOf(author), {
        title: "Login flickers on the dashboard",
      }).escalation;

      const hits = escalationService.findSimilarOpenEscalations(project.id, "Login flickers");
      expect(hits.some((h) => h.id === existing.id)).toBe(true);
      const hit = hits.find((h) => h.id === existing.id)!;
      expect(hit).toMatchObject({ id: existing.id, title: existing.title, kind: "bug_report" });
    });

    it("excludes a resolved near-duplicate (status != open)", () => {
      const project = createTestProject(testApp.db);
      const author = human();
      const esc = rawRaise(project.id, actorOf(author), {
        title: "Login flickers on the dashboard",
      }).escalation;
      // Drive to resolved (open→ack→answer→resolve).
      escalationService.acknowledge(esc.id, actorOf(author));
      escalationService.answer(esc.id, {}, actorOf(author));
      escalationService.resolve(esc.id, { reason: "fixed" }, actorOf(author));

      const hits = escalationService.findSimilarOpenEscalations(project.id, "Login flickers");
      expect(hits).toHaveLength(0);
    });

    it("excludes a near-duplicate in another project", () => {
      const projectA = createTestProject(testApp.db);
      const projectB = createTestProject(testApp.db);
      const author = agent();
      rawRaise(projectB.id, actorOf(author), { title: "Login flickers on the dashboard" });

      const hits = escalationService.findSimilarOpenEscalations(projectA.id, "Login flickers");
      expect(hits).toHaveLength(0);
    });

    it("returns [] for empty/whitespace input", () => {
      const project = createTestProject(testApp.db);
      expect(escalationService.findSimilarOpenEscalations(project.id, "")).toEqual([]);
      expect(escalationService.findSimilarOpenEscalations(project.id, "   ")).toEqual([]);
    });

    it("a throwing FTS query → [] AND a console.warn (de-silence: never silent)", () => {
      const project = createTestProject(testApp.db);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        getRawDb().exec("DROP TABLE escalations_fts");
        const hits = escalationService.findSimilarOpenEscalations(project.id, "anything here");
        expect(hits).toEqual([]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toContain("[escalation-dedup]");
        expect(String(warnSpy.mock.calls[0][0])).toContain("advisory");
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("an AND hit suppresses the OR fallback (precise pass wins)", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const full = rawRaise(project.id, actorOf(author), {
        title: "alpha bravo charlie delta echo",
      }).escalation;
      rawRaise(project.id, actorOf(author), { title: "charlie delta yankee" });

      const hits = escalationService.findSimilarOpenEscalations(
        project.id,
        "alpha bravo charlie delta echo",
      );
      const ids = hits.map((h) => h.id);
      expect(ids).toContain(full.id);
    });

    it("OR fallback recalls a partial-overlap when AND finds nothing", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const partial = rawRaise(project.id, actorOf(author), {
        title: "alpha bravo unrelated topic here",
      }).escalation;

      const hits = escalationService.findSimilarOpenEscalations(
        project.id,
        "alpha bravo charlie delta echo",
      );
      expect(hits.some((h) => h.id === partial.id)).toBe(true);
    });

    it("caps the OR fallback at 3 candidates (token-flood guard)", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      for (const word of ["alpha", "bravo", "charlie", "delta", "echo"]) {
        rawRaise(project.id, actorOf(author), { title: `${word} solo overlap line` });
      }

      const hits = escalationService.findSimilarOpenEscalations(
        project.id,
        "alpha bravo charlie delta echo",
      );
      expect(hits.length).toBeLessThanOrEqual(3);
    });
  });

  describe("create dedup auto-link", () => {
    function rawRaise(
      projectId: string,
      actor: { id: string; type: "human" | "ai_agent" },
      overrides: Partial<{ title: string; body: string; originRepo: string }> = {},
    ) {
      return escalationService.create(
        projectId,
        {
          kind: "bug_report",
          title: overrides.title ?? "Build is red",
          body: overrides.body,
          originRepo: overrides.originRepo ?? ORIGIN.originRepo,
          originWorkerKey: ORIGIN.originWorkerKey,
        },
        actor,
      );
    }

    it("an exact-title+same-origin+open dup folds: appends a reply, NO new row, emits replied not opened", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const first = rawRaise(project.id, actorOf(author), { title: "merge train wedged" });
      expect(first.merged).toBe(false);

      const events: string[] = [];
      const stop = getEventBus().onAll((event) => {
        if (event === EVENT_NAMES.ESCALATION_OPENED || event === EVENT_NAMES.ESCALATION_REPLIED) {
          events.push(event);
        }
      });

      // Re-raise with a whitespace/case variant of the SAME title.
      const second = rawRaise(project.id, actorOf(author), { title: "  MERGE   train wedged  " });

      stop();

      expect(second.merged).toBe(true);
      expect(second.mergedInto).toBe(first.escalation.id);
      expect(second.escalation.id).toBe(first.escalation.id);
      expect(events).toEqual([EVENT_NAMES.ESCALATION_REPLIED]);

      // No NEW escalation row was created (still exactly one).
      const all = testApp.db
        .select()
        .from(escalations)
        .where(eq(escalations.projectId, project.id))
        .all();
      expect(all).toHaveLength(1);

      // The thread grew (the folded raise is appended as a reply).
      const thread = escalationService.getById(first.escalation.id);
      expect(thread.messages.length).toBe(1);
      expect(thread.messages[0].messageType).toBe("reply");
    });

    it("a fuzzy-not-exact near-dup creates a NEW escalation (merged:false) + populates similar", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const first = rawRaise(project.id, actorOf(author), {
        title: "Login flickers on the dashboard",
      });

      const second = rawRaise(project.id, actorOf(author), {
        title: "Login flickers intermittently on the dashboard panel",
      });

      expect(second.merged).toBe(false);
      expect(second.mergedInto).toBeNull();
      expect(second.escalation.id).not.toBe(first.escalation.id);
      expect(second.similar.some((s) => s.id === first.escalation.id)).toBe(true);
    });

    it("exact title but DIFFERENT origin does NOT fold (new escalation)", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const first = rawRaise(project.id, actorOf(author), {
        title: "same title here",
        originRepo: "repo_a",
      });
      const second = rawRaise(project.id, actorOf(author), {
        title: "same title here",
        originRepo: "repo_b",
      });
      expect(second.merged).toBe(false);
      expect(second.escalation.id).not.toBe(first.escalation.id);
    });

    it("after a fold, list(status:open) returns exactly one open thread (responder short-circuit)", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      rawRaise(project.id, actorOf(author), { title: "the one true thread" });
      rawRaise(project.id, actorOf(author), { title: "the one true thread" });

      const open = escalationService.list(project.id, { status: "open" });
      expect(open).toHaveLength(1);
    });

    it("fail-safe: a broken escalations_fts (dropped table+triggers) → raise still succeeds as a normal create (merged:false, similar:[])", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        // Drop the sync triggers FIRST (else the escalations INSERT would
        // fault on a now-missing FTS table), then the FTS table — so the
        // dedup MATCH query throws but the underlying write is unaffected.
        const raw = getRawDb();
        raw.exec("DROP TRIGGER IF EXISTS escalations_fts_ai");
        raw.exec("DROP TRIGGER IF EXISTS escalations_fts_au");
        raw.exec("DROP TRIGGER IF EXISTS escalations_fts_ad");
        raw.exec("DROP TABLE escalations_fts");
        const res = rawRaise(project.id, actorOf(author), { title: "still works" });
        expect(res.merged).toBe(false);
        expect(res.similar).toEqual([]);
        expect(res.escalation.id).toBeTruthy();
        expect(res.escalation.status).toBe("open");
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ── C4 §P4: escalations_fts smoke ─────────────────────────────────
  describe("escalations_fts (programmatic FTS5)", () => {
    it("the table + 3 triggers exist on a fresh DB", () => {
      const raw = getRawDb();
      const tbl = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='escalations_fts'")
        .get();
      expect(tbl).toBeTruthy();
      const trigs = raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('escalations_fts_ai','escalations_fts_au','escalations_fts_ad') ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(trigs.map((t) => t.name)).toEqual([
        "escalations_fts_ad",
        "escalations_fts_ai",
        "escalations_fts_au",
      ]);
    });

    it("a raised escalation is indexed (MATCH on a title term returns it)", () => {
      const project = createTestProject(testApp.db);
      const author = agent();
      const esc = escalationService.create(
        project.id,
        {
          kind: "bug_report",
          title: "indexed distinctiveterm here",
          originRepo: ORIGIN.originRepo,
          originWorkerKey: ORIGIN.originWorkerKey,
        },
        actorOf(author),
      ).escalation;

      const rows = getRawDb()
        .prepare(
          "SELECT e.id FROM escalations_fts JOIN escalations e ON e.rowid = escalations_fts.rowid WHERE escalations_fts MATCH ?",
        )
        .all('"distinctiveterm"') as Array<{ id: string }>;
      expect(rows.some((r) => r.id === esc.id)).toBe(true);
    });
  });
});
