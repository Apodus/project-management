import { z } from "zod";
import { DEPENDENCY_TYPES } from "../constants/enums.js";
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
  created_at: timestampSchema,
  updated_at: timestampSchema,
  taskSummary: epicTaskSummarySchema,
  // P4 enrichment — optional in skeleton so P2's enrichment-free payload validates.
  health: z.string().optional(), // enum tightening deferred to P4; consumers treat as opaque
  activity_recency: z.string().nullable().optional(),
  time_window: z.object({ start: z.string().nullable(), end: z.string().nullable() }).optional(),
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
