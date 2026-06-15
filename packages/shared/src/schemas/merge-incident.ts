import { z } from "zod";

// ─── Enums ────────────────────────────────────────────────────────
// State of a merge incident. First element ("open") matches the
// merge_incidents.state column default in
// packages/server/src/db/schema.ts. Incident state machine lives in
// docs/design/phase-7.3-design.md §4.2:
//   open → auto_resolved | human_resolved
export const MERGE_INCIDENT_STATES = ["open", "auto_resolved", "human_resolved"] as const;
export type MergeIncidentState = (typeof MERGE_INCIDENT_STATES)[number];

// Incident type. For 7.3 the only value is "orphaned_inner" — an enum so
// 7.4+ can add types without a schema change.
export const MERGE_INCIDENT_TYPES = ["orphaned_inner"] as const;
export type MergeIncidentType = (typeof MERGE_INCIDENT_TYPES)[number];

// ─── Resolution ───────────────────────────────────────────────────
// Structured resolution payload stored on merge_incidents.resolution
// (JSON column). Null while open. `auto_rollforward` heals the orphan by
// a follow-up outer land (§7); `human` records a manual resolution (§7.5).
export const mergeIncidentResolutionSchema = z.object({
  mode: z.enum(["auto_rollforward", "human"]),
  outerLandedSha: z.string().optional(),
  resolvedByGroupId: z.string().optional(),
  note: z.string().optional(),
});
export type MergeIncidentResolution = z.infer<typeof mergeIncidentResolutionSchema>;

// ─── View shapes ──────────────────────────────────────────────────
// Full GET response shape for a merge_incidents row. Field names mirror
// the Drizzle TS property names (camelCase) from
// packages/server/src/db/schema.ts §mergeIncidents.
export const mergeIncidentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  groupId: z.string().nullable(),
  type: z.enum(MERGE_INCIDENT_TYPES),
  innerRepo: z.string(),
  orphanedSha: z.string(),
  outerRepo: z.string(),
  innerRequestId: z.string().nullable(),
  taskId: z.string().nullable(),
  state: z.enum(MERGE_INCIDENT_STATES),
  openedAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolution: mergeIncidentResolutionSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MergeIncidentView = z.infer<typeof mergeIncidentSchema>;
