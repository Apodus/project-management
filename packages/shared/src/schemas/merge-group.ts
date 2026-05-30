import { z } from "zod";

// ─── Enums ────────────────────────────────────────────────────────
// State of a merge request group through its lifecycle. First element
// ("forming") matches the merge_request_groups.state column default in
// packages/server/src/db/schema.ts. Group state machine lives in
// docs/design/phase-7.3-design.md §3.3:
//   forming → integrating → landed | rejected | partially_landed
//   forming → rejected (abandoned while forming)
export const MERGE_GROUP_STATES = [
  "forming",
  "integrating",
  "landed",
  "rejected",
  "partially_landed",
] as const;
export type MergeGroupState = (typeof MERGE_GROUP_STATES)[number];

// ─── View shapes ──────────────────────────────────────────────────
// Full GET response shape for a merge_request_groups row. Field names
// mirror the Drizzle TS property names (camelCase) from
// packages/server/src/db/schema.ts §mergeRequestGroups.
export const mergeRequestGroupSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  resource: z.string(),
  state: z.enum(MERGE_GROUP_STATES),
  submittedBy: z.string(),
  integratorId: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolutionReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MergeRequestGroupView = z.infer<typeof mergeRequestGroupSchema>;

// ─── Request bodies ───────────────────────────────────────────────
// Body for POST /api/v1/projects/{projectId}/merge-groups.
// submittedBy comes from auth; projectId comes from the URL.
// `resource` defaults to "main" — matches the DB column default.
export const createMergeGroupSchema = z.object({
  resource: z.string().min(1).default("main"),
  // Minimum-viable-group constraint: a cross-repo group is always ≥2
  // members (inner + outer), so an empty/singleton group is meaningless.
  memberRequestIds: z.array(z.string().min(1)).min(2),
});
export type CreateMergeGroup = z.infer<typeof createMergeGroupSchema>;
