import { z } from "zod";
import { DEPENDENCY_TYPES } from "../constants/enums.js";
import { ulidSchema } from "./common.js";
import { EDGE_PROVENANCES } from "./epic-graph.js";

// A task-graph node is a single task within an epic. Status/priority/type are
// free strings to mirror epic-graph's permissiveness (the canonical enums live
// on the task schema; the graph view stays display-oriented).
export const taskGraphNodeSchema = z.object({
  id: ulidSchema,
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  type: z.string(),
  assignee_id: ulidSchema.nullable(),
  done: z.boolean(),
});

export const taskGraphEdgeSchema = z.object({
  from: ulidSchema, // prerequisite (depends_on_task_id)
  to: ulidSchema, // dependent (task_id)
  dependency_type: z.enum(DEPENDENCY_TYPES),
  provenance: z.enum(EDGE_PROVENANCES),
});

export const taskGraphSchema = z.object({
  nodes: z.array(taskGraphNodeSchema),
  edges: z.array(taskGraphEdgeSchema),
  hasCycle: z.boolean(),
  cycles: z.array(z.array(ulidSchema)).optional(),
});
