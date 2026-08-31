import { z } from "zod";

// ─── Enums ────────────────────────────────────────────────────────
// State of a merge incident. First element ("open") matches the
// merge_incidents.state column default in
// packages/server/src/db/schema.ts. Incident state machine lives in
// docs/design/phase-7.3-design.md §4.2:
//   open → auto_resolved | human_resolved
export const MERGE_INCIDENT_STATES = ["open", "auto_resolved", "human_resolved"] as const;
export type MergeIncidentState = (typeof MERGE_INCIDENT_STATES)[number];

// Incident type. Two directions of the SAME broken invariant between an inner
// repo's main and the outer repo's committed gitlink:
//   orphaned_inner   — inner main landed; the outer gitlink did NOT follow.
//   dangling_gitlink — outer main's gitlink points at a commit that is NOT on
//                      inner main.
// `type` is a bare text column server-side, so a new value needs NO migration.
export const MERGE_INCIDENT_TYPES = ["orphaned_inner", "dangling_gitlink"] as const;
export type MergeIncidentType = (typeof MERGE_INCIDENT_TYPES)[number];

// ─── Type registry ────────────────────────────────────────────────
// Design lock 6 ("the invariant is symmetric, so the detector must be")
// expressed as a type: MERGE_INCIDENT_TYPE_INFO is a Record keyed by the
// union, so a future incident type cannot silently inherit orphaned_inner's
// wording — omitting it is a compile error in @pm/shared, before it reaches
// any renderer.
//
// WORDING RULE (binding, roadmap finding 2b). Every string here states the
// INVARIANT, never a symptom. In particular nothing here may say or imply
// either of:
//   - "an unclassifiable assembly error ⇒ a dangling gitlink" (the outer pool
//     slot's populated-but-unopenable gitlink path makes ANY gitlink bump on
//     main fail the next fetch, dangling or not); or
//   - "no dangling_gitlink incident ⇒ the lane's main is sane" (the check runs
//     at assembly, and other faults produce the same symptom).
export interface MergeIncidentTypeInfo {
  /** WHICH DIRECTION of the inner/outer invariant this type records. Required:
   *  a type that cannot say which direction it watches is the bug class design
   *  lock 6 exists to prevent. */
  direction: "inner_ahead_of_outer" | "outer_ahead_of_inner";
  /** Short human label. Chips/headers title-case it themselves. */
  label: string;
  /** What `merge_incidents.orphaned_sha` holds for THIS type. The column name
   *  predates the second type; this field is the documented reuse, in the one
   *  place every renderer reads. */
  shaMeaning: string;
  /** ONE self-identifying sentence stating the OBSERVED broken invariant. It
   *  BEGINS with `${label}: ` so any surface can print it standalone. An
   *  observation only — no cure advice, no blame, no exoneration (design
   *  lock 3). */
  summary(ctx: { innerRepo: string; outerRepo: string; sha: string }): string;
  /** Who can cure it — a machine fact, used by incident surfaces to say whether
   *  the train will act. orphaned_inner → "train" (the §7.2 rollforward).
   *  dangling_gitlink → "human" (design lock 2: both cures change what
   *  consumers of main compile, so the train detects and refuses, never
   *  picks). */
  curedBy: "train" | "human";
}

export const MERGE_INCIDENT_TYPE_INFO: Record<MergeIncidentType, MergeIncidentTypeInfo> = {
  orphaned_inner: {
    direction: "inner_ahead_of_outer",
    label: "Orphaned inner",
    shaMeaning: "the inner commit that landed on inner main while the outer gitlink stayed behind",
    summary: ({ innerRepo, outerRepo, sha }) =>
      `Orphaned inner: ${innerRepo}@${sha} landed on inner main, but ${outerRepo}'s ` +
      `gitlink was not updated to it.`,
    curedBy: "train",
  },
  dangling_gitlink: {
    direction: "outer_ahead_of_inner",
    label: "Dangling gitlink",
    shaMeaning: "the gitlink target recorded on outer main that is not reachable from inner main",
    summary: ({ innerRepo, outerRepo, sha }) =>
      `Dangling gitlink: ${outerRepo} main's gitlink points at ${sha}, which is not on ` +
      `${innerRepo} main.`,
    curedBy: "human",
  },
};

/**
 * The INVERSE of MERGE_INCIDENT_TYPE_INFO's `direction`. Two total Records over
 * the two halves of one relation: adding a direction is a compile error until
 * it has a detector, and adding a type is a compile error until it names a
 * direction. Design lock 6, made mechanical (campaign 2026-08-30 §S2).
 *
 * The indirection is the point at the call site: a detector declares the
 * DIRECTION it measured and lets the row type follow, rather than naming a row
 * to write. Roadmap finding 4 was that nothing asserted every direction HAS a
 * detector; this is that assertion, as far as a type can carry it.
 *
 * Honest limit: this makes a MISSING detector for a DECLARED direction
 * uncompilable. It cannot make anyone declare a direction that has not occurred
 * to them.
 */
export const MERGE_INCIDENT_TYPE_BY_DIRECTION: Record<
  MergeIncidentTypeInfo["direction"],
  MergeIncidentType
> = {
  inner_ahead_of_outer: "orphaned_inner",
  outer_ahead_of_inner: "dangling_gitlink",
};

/**
 * Total, string-tolerant lookup. DB rows type `type` as plain `string`, so
 * server-side consumers need this rather than an index expression. An
 * unrecognized value returns undefined and the caller must then state nothing
 * directional about it — a catch-all is never a diagnosis (design lock 4).
 */
export function mergeIncidentTypeInfo(type: string): MergeIncidentTypeInfo | undefined {
  // Own-key check: the argument is an untrusted wire/DB string, and a bare
  // index would happily hand back Object.prototype.toString for type
  // "toString".
  return Object.prototype.hasOwnProperty.call(MERGE_INCIDENT_TYPE_INFO, type)
    ? (MERGE_INCIDENT_TYPE_INFO as Record<string, MergeIncidentTypeInfo>)[type]
    : undefined;
}

// ─── Resolution ───────────────────────────────────────────────────
// Structured resolution payload stored on merge_incidents.resolution
// (JSON column). Null while open.
//   auto_rollforward — the train APPLIED a cure: a follow-up outer land (§7).
//   auto_observed    — the train OBSERVED a cure it did not apply: the
//                      invariant holds again (design lock 2 — for a
//                      dangling gitlink a human cures, the train only looks).
//   human            — a manual resolution (§7.5).
// Both auto modes are ai_agent-gated and terminate at "auto_resolved".
export const MERGE_INCIDENT_RESOLUTION_MODES = [
  "auto_rollforward",
  "auto_observed",
  "human",
] as const;
export type MergeIncidentResolutionMode = (typeof MERGE_INCIDENT_RESOLUTION_MODES)[number];

export const mergeIncidentResolutionSchema = z.object({
  mode: z.enum(MERGE_INCIDENT_RESOLUTION_MODES),
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
