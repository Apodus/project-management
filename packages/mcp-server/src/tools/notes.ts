import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  NOTE_KINDS,
  NOTE_STATUSES,
  NOTE_ANCHOR_TYPES,
  NOTE_SEVERITIES,
} from "@pm/shared";
import { createNote, listNotes, getNote } from "../api-client.js";

/**
 * Notes — a lightweight, ownerless capture surface (Campaign C1). No claim is
 * involved: a note belongs to no one, it's just jotted down. Snake_case tool
 * params map to the camelCase client/wire shape (pm_create_task convention).
 */
export function registerNoteTools(server: McpServer): void {
  // ---- pm_post_note ----

  server.tool(
    "pm_post_note",
    "Capture a quick note when you notice something off mid-task but don't want to stop and investigate now — a bug, a WTF, tech debt, an idea, a question, or an observation. Ownerless and lightweight (no claim needed). Identity is derived from your session. Returns the saved note plus any possibly-similar open notes so you can avoid duplicates.",
    {
      project_id: z.string().describe("The project ID to file the note under"),
      kind: z
        .enum(NOTE_KINDS)
        .describe("Classification: bug | question | idea | tech_debt | wtf | observation"),
      title: z.string().describe("One-line handle for the note"),
      body: z.string().optional().describe("Optional longer detail (markdown)"),
      anchor_type: z
        .enum(NOTE_ANCHOR_TYPES)
        .optional()
        .describe("Optionally anchor to an entity: task | epic | proposal"),
      anchor_id: z.string().optional().describe("ID of the anchored entity"),
      code_locator: z
        .object({
          path: z.string().describe("File path the note refers to"),
          line: z.number().int().positive().optional().describe("Line number"),
          commit_sha: z.string().optional().describe("Commit SHA for context"),
        })
        .optional()
        .describe("Optional pointer into the codebase"),
      severity: z
        .enum(NOTE_SEVERITIES)
        .optional()
        .describe("Optional severity hint (most meaningful for bug/tech_debt): low | medium | high"),
    },
    async ({ project_id, kind, title, body, anchor_type, anchor_id, code_locator, severity }) => {
      const { note, similar } = await createNote(project_id, {
        kind,
        title,
        body: body ?? null,
        anchorType: anchor_type ?? null,
        anchorId: anchor_id ?? null,
        codeLocator: code_locator
          ? {
              path: code_locator.path,
              line: code_locator.line,
              commitSha: code_locator.commit_sha,
            }
          : null,
        severity: severity ?? null,
      });

      const sections: string[] = [
        "Note captured.",
        "",
        `**ID:** ${note.id}`,
        `**Kind:** ${note.kind}`,
        `**Title:** ${note.title}`,
        `**Status:** ${note.status}`,
        `**Project:** ${note.projectId}`,
      ];

      if (note.severity) sections.push(`**Severity:** ${note.severity}`);
      if (note.anchorType && note.anchorId) {
        sections.push(`**Anchor:** ${note.anchorType} ${note.anchorId}`);
      }
      if (note.codeLocator) {
        const loc = note.codeLocator;
        const locText =
          loc.path +
          (loc.line !== undefined ? `:${loc.line}` : "") +
          (loc.commitSha ? ` @ ${loc.commitSha}` : "");
        sections.push(`**Code:** ${locText}`);
      }

      if (similar.length > 0) {
        sections.push(
          "",
          `⚠ ${similar.length} possibly-similar open note(s) — check for duplicates:`,
        );
        for (const s of similar) {
          sections.push(`- **${s.title}** (${s.kind}) — ID: ${s.id}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
      };
    },
  );

  // ---- pm_list_notes ----

  server.tool(
    "pm_list_notes",
    "List notes captured in a project (bugs/questions/ideas/tech-debt/WTFs/observations), with optional filters. Notes are ownerless — there's no claim to take.",
    {
      project_id: z.string().describe("The project ID to list notes for"),
      status: z.enum(NOTE_STATUSES).optional().describe("Filter by status: open | triaged"),
      kind: z.enum(NOTE_KINDS).optional().describe("Filter by kind"),
      anchor_type: z.enum(NOTE_ANCHOR_TYPES).optional().describe("Filter by anchor entity type"),
      anchor_id: z.string().optional().describe("Filter by anchored entity ID"),
      severity: z.enum(NOTE_SEVERITIES).optional().describe("Filter by severity"),
    },
    async ({ project_id, status, kind, anchor_type, anchor_id, severity }) => {
      const notes = await listNotes(project_id, {
        status,
        kind,
        anchorType: anchor_type,
        anchorId: anchor_id,
        severity,
      });

      if (notes.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No notes found." }],
        };
      }

      const lines: string[] = [`Found ${notes.length} note(s):`, ""];
      for (const note of notes) {
        const head =
          `**[${note.kind}]**` +
          (note.severity ? ` (${note.severity})` : "") +
          ` ${note.title}`;
        lines.push(head);
        const meta = [`ID: ${note.id}`, `Status: ${note.status}`];
        if (note.anchorType && note.anchorId) {
          meta.push(`Anchor: ${note.anchorType} ${note.anchorId}`);
        }
        lines.push(`  ${meta.join(" | ")}`);
        lines.push("");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n").trimEnd() }],
      };
    },
  );

  // ---- pm_get_note ----

  server.tool(
    "pm_get_note",
    "Get the full detail of a single note by ID. Notes are ownerless (no claim, no comments).",
    {
      note_id: z.string().describe("The note ID to fetch"),
    },
    async ({ note_id }) => {
      const note = await getNote(note_id);

      const sections: string[] = [
        `# ${note.title}`,
        "",
        `**ID:** ${note.id}`,
        `**Kind:** ${note.kind}`,
        `**Status:** ${note.status}`,
      ];

      if (note.severity) sections.push(`**Severity:** ${note.severity}`);
      sections.push(
        `**Project:** ${note.projectId}`,
        `**Author:** ${note.authorId}`,
        `**Created:** ${note.createdAt}`,
        `**Updated:** ${note.updatedAt}`,
      );

      if (note.anchorType && note.anchorId) {
        sections.push("", "**Anchor:**", `- ${note.anchorType}: ${note.anchorId}`);
      }

      if (note.codeLocator) {
        const loc = note.codeLocator;
        sections.push("", "**Code locator:**", `- Path: ${loc.path}`);
        if (loc.line !== undefined) sections.push(`- Line: ${loc.line}`);
        if (loc.commitSha) sections.push(`- Commit: ${loc.commitSha}`);
      }

      if (note.body) {
        sections.push("", "---", "", note.body);
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
      };
    },
  );
}
