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
// One member of the atomic submit-and-group form. Field names mirror the
// merge-request submit body (camelCase: commitSha / verifyCmd / taskId) so the
// whole merge surface is wire-consistent. A spec must name SOMETHING to land —
// at least one of branch / commitSha.
export const mergeGroupMemberSpecSchema = z
  .object({
    branch: z.string().min(1).optional(),
    commitSha: z.string().min(1).optional(),
    verifyCmd: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
  })
  .refine((s) => !!(s.branch || s.commitSha), {
    message: "Each member spec needs at least one of branch / commitSha.",
  });
export type MergeGroupMemberSpec = z.infer<typeof mergeGroupMemberSpecSchema>;

// Body for POST /api/v1/projects/{projectId}/merge-groups.
// submittedBy comes from auth; projectId comes from the URL.
// `resource` defaults to "main" — matches the DB column default.
//
// Exactly-one-of `memberRequestIds` | `members` (a FLAT object + superRefine,
// NOT `.and(z.union(...))` — a union would strip the unselected key and defeat
// the both/neither guard):
//   - memberRequestIds: the back-compat form — bind >=2 ALREADY-queued,
//     ungrouped requests into a group (the legacy two-step submit-then-group;
//     this arm is byte-identical to the pre-7.3-hardening shape).
//   - members: the atomic form — submit >=2 NEW member requests AND form the
//     group in one call, so members are born group-bound and a single-repo
//     pickup can never grab one mid-grouping (closes the submit/group race).
export const createMergeGroupSchema = z
  .object({
    resource: z.string().min(1).default("main"),
    // Minimum-viable-group constraint: a cross-repo group is always ≥2
    // members (inner + outer), so an empty/singleton group is meaningless.
    memberRequestIds: z.array(z.string().min(1)).min(2).optional(),
    members: z.array(mergeGroupMemberSpecSchema).min(2).optional(),
  })
  .superRefine((v, ctx) => {
    const hasIds = v.memberRequestIds !== undefined;
    const hasSpecs = v.members !== undefined;
    if (hasIds === hasSpecs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of memberRequestIds or members.",
      });
    }
  });
export type CreateMergeGroup = z.infer<typeof createMergeGroupSchema>;
