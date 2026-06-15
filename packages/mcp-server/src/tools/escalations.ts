import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ESCALATION_KINDS,
  ESCALATION_STATUSES,
  ESCALATION_SEVERITIES,
  ESCALATION_ANCHOR_TYPES,
  ESCALATION_MESSAGE_TYPES,
} from "@pm/shared";
import {
  createEscalation,
  listEscalations,
  getEscalation,
  addEscalationMessage,
  acknowledgeEscalation,
  answerEscalation,
  resolveEscalation,
  escalateToHuman,
} from "../api-client.js";

/**
 * Escalation channel (Campaign C1) — a durable, threaded, cross-team channel.
 * A worker in its own repo raises a typed issue (bug_report/question/request/
 * blocked) against the platform/PM project; the PM side acknowledges, answers,
 * and resolves it. Both sides reply through the SAME append-only thread, so the
 * 8 tools are symmetric — thin wrappers over the P3 REST surface (authz +
 * lifecycle are single-sourced in the service). Snake_case tool params map to
 * the camelCase wire shape (pm_post_note convention); ApiError propagates.
 */

/**
 * A short "Next: ..." hint keyed off the escalation status, mirroring the
 * "Next:" style of the notes tools. Returns "" for statuses where no hint adds
 * value, so callers can append it unconditionally.
 */
function lifecycleHint(status: string): string {
  switch (status) {
    case "open":
      return "Next: a responder calls pm_acknowledge_escalation to pick it up.";
    case "acknowledged":
      return "Next: call pm_answer_escalation with your diagnosis, or pm_escalate_to_human if it needs a person.";
    case "answered":
      return "Next: the author reviews the answer, then pm_resolve_escalation closes it (or reply to continue the thread).";
    case "needs_human":
      return "Next: a human picks this up; reply on the thread to add context.";
    case "resolved":
      return "Resolved — the thread is append-frozen.";
    default:
      return "";
  }
}

export function registerEscalationTools(server: McpServer): void {
  // ---- pm_raise_escalation ----

  server.tool(
    "pm_raise_escalation",
    "Raise a typed issue to the platform/PM team when you hit a problem you can't resolve in your own repo — a bug_report in the platform tooling, a question about how something works, a request for a change, or you're blocked. Opens a durable threaded cross-team channel. Returns the new escalation id + status; call pm_get_escalation to read replies.",
    {
      project_id: z
        .string()
        .describe("The target platform/PM project ID to raise the escalation against"),
      kind: z
        .enum(ESCALATION_KINDS)
        .describe("Classification: bug_report | question | request | blocked"),
      title: z.string().describe("One-line handle for the escalation"),
      body: z.string().optional().describe("Optional longer detail (markdown)"),
      severity: z
        .enum(ESCALATION_SEVERITIES)
        .optional()
        .describe("Optional severity hint: low | medium | high"),
      code_locator: z
        .object({
          path: z.string().describe("File path the escalation refers to"),
          line: z.number().int().positive().optional().describe("Line number"),
          commit_sha: z.string().optional().describe("Commit SHA for context"),
        })
        .optional()
        .describe("Optional pointer into the codebase"),
      anchor_type: z
        .enum(ESCALATION_ANCHOR_TYPES)
        .optional()
        .describe("Optionally anchor to an entity: task | epic | proposal"),
      anchor_id: z.string().optional().describe("ID of the anchored entity"),
      origin_repo: z
        .string()
        .describe("The repo you are raising this FROM (your own repo's name/identifier)"),
      origin_worker_key: z
        .string()
        .describe("Your worker key (the cross-team provenance of who raised this)"),
    },
    async ({
      project_id,
      kind,
      title,
      body,
      severity,
      code_locator,
      anchor_type,
      anchor_id,
      origin_repo,
      origin_worker_key,
    }) => {
      const escalation = await createEscalation(project_id, {
        kind,
        title,
        body: body ?? null,
        severity: severity ?? null,
        codeLocator: code_locator
          ? {
              path: code_locator.path,
              line: code_locator.line,
              commitSha: code_locator.commit_sha,
            }
          : null,
        anchorType: anchor_type ?? null,
        anchorId: anchor_id ?? null,
        originRepo: origin_repo,
        originWorkerKey: origin_worker_key,
      });

      const sections: string[] = [
        "Escalation raised.",
        "",
        `**ID:** ${escalation.id}`,
        `**Kind:** ${escalation.kind}`,
        `**Title:** ${escalation.title}`,
        `**Status:** ${escalation.status}`,
      ];

      if (escalation.severity) sections.push(`**Severity:** ${escalation.severity}`);
      sections.push(`**Project:** ${escalation.projectId}`);
      sections.push(`**Origin:** ${escalation.originRepo} · ${escalation.originWorkerKey}`);

      if (escalation.anchorType && escalation.anchorId) {
        sections.push(`**Anchor:** ${escalation.anchorType} ${escalation.anchorId}`);
      }
      if (escalation.codeLocator) {
        const loc = escalation.codeLocator;
        const locText =
          loc.path +
          (loc.line !== undefined ? `:${loc.line}` : "") +
          (loc.commitSha ? ` @ ${loc.commitSha}` : "");
        sections.push(`**Code:** ${locText}`);
      }

      sections.push("", "To check for a reply, call pm_get_escalation with this ID.");

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
      };
    },
  );

  // ---- pm_reply_escalation ----

  server.tool(
    "pm_reply_escalation",
    "Add a message to an escalation thread — either side (the author who raised it, or a PM-side responder). Use to ask a follow-up, supply requested detail, or continue a diagnosis. The thread is append-only; a resolved escalation is frozen.",
    {
      escalation_id: z.string().describe("The escalation ID to reply to"),
      body: z.string().describe("The message body (markdown)"),
      message_type: z
        .enum(ESCALATION_MESSAGE_TYPES)
        .optional()
        .describe("Optional classification: reply | diagnosis | instruction | system"),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional structured metadata to attach to the message"),
    },
    async ({ escalation_id, body, message_type, metadata }) => {
      const escalation = await addEscalationMessage(escalation_id, {
        body,
        messageType: message_type,
        metadata,
      });

      const sections: string[] = [
        "Reply added.",
        "",
        `**ID:** ${escalation.id}`,
        `**Status:** ${escalation.status}`,
        "",
        "Use pm_get_escalation to see the full thread.",
      ];

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
      };
    },
  );

  // ---- pm_get_escalation ----

  server.tool(
    "pm_get_escalation",
    "Get the full detail of a single escalation by ID, including the ENTIRE message thread in order. Use this to read replies after raising or responding to an escalation.",
    {
      escalation_id: z.string().describe("The escalation ID to fetch"),
    },
    async ({ escalation_id }) => {
      const escalation = await getEscalation(escalation_id);

      const sections: string[] = [
        `# ${escalation.title}`,
        "",
        `**ID:** ${escalation.id}`,
        `**Kind:** ${escalation.kind}`,
        `**Status:** ${escalation.status}`,
      ];

      if (escalation.severity) sections.push(`**Severity:** ${escalation.severity}`);
      sections.push(
        `**Project:** ${escalation.projectId}`,
        `**Origin:** ${escalation.originRepo} · ${escalation.originWorkerKey}`,
        `**Author:** ${escalation.authorId}`,
        `**Holder:** ${escalation.holderId ?? "(unclaimed)"}`,
        `**Created:** ${escalation.createdAt}`,
        `**Updated:** ${escalation.updatedAt}`,
      );

      if (escalation.resolvedAt) {
        sections.push(
          `**Resolved:** ${escalation.resolvedAt}${
            escalation.resolvedBy ? ` by ${escalation.resolvedBy}` : ""
          }`,
        );
      }

      if (escalation.anchorType && escalation.anchorId) {
        sections.push("", "**Anchor:**", `- ${escalation.anchorType}: ${escalation.anchorId}`);
      }

      if (escalation.codeLocator) {
        const loc = escalation.codeLocator;
        sections.push("", "**Code locator:**", `- Path: ${loc.path}`);
        if (loc.line !== undefined) sections.push(`- Line: ${loc.line}`);
        if (loc.commitSha) sections.push(`- Commit: ${loc.commitSha}`);
      }

      if (escalation.body) {
        sections.push("", "---", "", escalation.body);
      }

      const messages = escalation.messages ?? [];
      sections.push("", `## Thread (${messages.length} messages)`, "");
      for (const msg of messages) {
        sections.push(
          `**#${msg.seq}** (${msg.messageType ?? "reply"}) — ${msg.createdAt}`,
          msg.body,
          "",
        );
      }

      const hint = lifecycleHint(escalation.status);
      if (hint) sections.push(hint);

      return {
        content: [{ type: "text" as const, text: sections.join("\n").trimEnd() }],
      };
    },
  );

  // ---- pm_list_escalations ----

  server.tool(
    "pm_list_escalations",
    "List escalations raised against a project (newest first), with optional filters. Use to triage the cross-team channel — find open issues, your own origin's escalations, or what a given holder is working.",
    {
      project_id: z.string().describe("The project ID to list escalations for"),
      status: z
        .enum(ESCALATION_STATUSES)
        .optional()
        .describe("Filter by status: open | acknowledged | answered | resolved | needs_human"),
      kind: z.enum(ESCALATION_KINDS).optional().describe("Filter by kind"),
      severity: z.enum(ESCALATION_SEVERITIES).optional().describe("Filter by severity"),
      origin_repo: z.string().optional().describe("Filter by origin repo"),
      origin_worker_key: z.string().optional().describe("Filter by origin worker key"),
      holder_id: z.string().optional().describe("Filter by current holder"),
    },
    async ({ project_id, status, kind, severity, origin_repo, origin_worker_key, holder_id }) => {
      const escalations = await listEscalations(project_id, {
        status,
        kind,
        severity,
        originRepo: origin_repo,
        originWorkerKey: origin_worker_key,
        holderId: holder_id,
      });

      if (escalations.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No escalations found." }],
        };
      }

      const lines: string[] = [`Found ${escalations.length} escalation(s):`, ""];
      for (const e of escalations) {
        const head = `**[${e.kind}]**` + (e.severity ? ` (${e.severity})` : "") + ` ${e.title}`;
        lines.push(head);
        lines.push(
          `  ID: ${e.id} | Status: ${e.status} | Origin: ${e.originRepo} · ${e.originWorkerKey}`,
        );
        lines.push("");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n").trimEnd() }],
      };
    },
  );

  // ---- pm_acknowledge_escalation ----

  server.tool(
    "pm_acknowledge_escalation",
    "PM-side pickup of an open escalation (open → acknowledged). An AI responder that acknowledges an unclaimed escalation becomes its holder. Use this when you (the PM/platform side) are taking the issue on.",
    {
      escalation_id: z.string().describe("The escalation ID to acknowledge"),
    },
    async ({ escalation_id }) => {
      const escalation = await acknowledgeEscalation(escalation_id);

      const sections: string[] = [
        "Escalation acknowledged.",
        "",
        `**ID:** ${escalation.id}`,
        `**Status:** ${escalation.status}`,
      ];
      const hint = lifecycleHint(escalation.status);
      if (hint) sections.push("", hint);

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
      };
    },
  );

  // ---- pm_answer_escalation ----

  server.tool(
    "pm_answer_escalation",
    "PM-side answer of an acknowledged escalation (acknowledged → answered). Optionally include an answer/diagnosis message in `body`. Answering an unclaimed escalation self-claims it. Use this when you have a diagnosis or resolution to hand back to the author.",
    {
      escalation_id: z.string().describe("The escalation ID to answer"),
      body: z
        .string()
        .optional()
        .describe("Optional answer/diagnosis message appended to the thread"),
    },
    async ({ escalation_id, body }) => {
      const escalation = await answerEscalation(escalation_id, { body });

      const sections: string[] = [
        "Escalation answered.",
        "",
        `**ID:** ${escalation.id}`,
        `**Status:** ${escalation.status}`,
      ];
      const hint = lifecycleHint(escalation.status);
      if (hint) sections.push("", hint);

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
      };
    },
  );

  // ---- pm_resolve_escalation ----

  server.tool(
    "pm_resolve_escalation",
    "Resolve an escalation (→ resolved, terminal). A reason is required and recorded on the thread. Use when the issue is settled — the author may withdraw it from any non-terminal state; a responder resolves it once answered.",
    {
      escalation_id: z.string().describe("The escalation ID to resolve"),
      reason: z.string().describe("Why this is resolved (required, recorded as a system message)"),
    },
    async ({ escalation_id, reason }) => {
      const escalation = await resolveEscalation(escalation_id, reason);

      const sections: string[] = [
        "Escalation resolved.",
        "",
        `**ID:** ${escalation.id}`,
        `**Status:** ${escalation.status}`,
        `**Resolved by:** ${escalation.resolvedBy ?? "(unknown)"}`,
        `**Resolved at:** ${escalation.resolvedAt ?? "(unknown)"}`,
        `**Reason:** ${reason}`,
      ];

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
      };
    },
  );

  // ---- pm_escalate_to_human ----

  server.tool(
    "pm_escalate_to_human",
    "Escalate to a human (any non-terminal state → needs_human). A reason is required. Use when the issue needs a person — it's beyond what an AI responder should decide, or it's stuck.",
    {
      escalation_id: z.string().describe("The escalation ID to escalate to a human"),
      reason: z.string().describe("Why a human is needed (required, recorded as a system message)"),
    },
    async ({ escalation_id, reason }) => {
      const escalation = await escalateToHuman(escalation_id, reason);

      const sections: string[] = [
        "Escalated to a human.",
        "",
        `**ID:** ${escalation.id}`,
        `**Status:** ${escalation.status}`,
        `**Reason:** ${reason}`,
      ];

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
      };
    },
  );
}
