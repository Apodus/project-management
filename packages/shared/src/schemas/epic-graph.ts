import { z } from "zod";
import { DEPENDENCY_TYPES, EPIC_HEALTHS, CLAIM_STATES } from "../constants/enums.js";
import { ulidSchema, timestampSchema } from "./common.js";

// Edge provenance: `derived` = rolled up from the task graph (P2);
// `explicit` = authored planning-time epic edge from epic_dependencies (P3).
export const EDGE_PROVENANCES = ["derived", "explicit"] as const;

export const epicTaskSummarySchema = z.object({
  total: z.number().int(),
  done: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
});

export const epicGraphNodeSchema = z.object({
  id: ulidSchema,
  project_id: ulidSchema,
  name: z.string().min(1),
  status: z.string(),
  priority: z.string(),
  target_date: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  taskSummary: epicTaskSummarySchema,
  // C3.P4: claim liveness folded onto the node so the roadmap canvas can
  // surface stale/live/yours/unclaimed at a glance (sourced from epicService.list).
  claimState: z.enum(CLAIM_STATES),
  // P4 enrichment — finalized & REQUIRED. getGraph always emits all three:
  //   health           — EPIC_HEALTHS enum (done > blocked > at_risk > not_started > on_track)
  //   activity_recency — max(task.updated_at), falling back to epic.updated_at (NOT NULL ⇒ always present)
  //   time_window      — { start: created_at (non-null), end: target_date | null }
  health: z.enum(EPIC_HEALTHS),
  activity_recency: z.string(),
  time_window: z.object({ start: z.string(), end: z.string().nullable() }),
});

export const epicGraphEdgeSchema = z.object({
  from: ulidSchema, // prerequisite (depends_on_epic_id)
  to: ulidSchema, // dependent (epic_id)
  dependency_type: z.enum(DEPENDENCY_TYPES),
  provenance: z.enum(EDGE_PROVENANCES),
});

export const epicGraphSchema = z.object({
  nodes: z.array(epicGraphNodeSchema),
  edges: z.array(epicGraphEdgeSchema),
  hasCycle: z.boolean(),
  cycles: z.array(z.array(ulidSchema)).optional(),
});
