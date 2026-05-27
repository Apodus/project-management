import { z } from "zod";
import { DEPENDENCY_TYPES } from "../constants/enums.js";
import { ulidSchema, timestampSchema } from "./common.js";

export const selectTaskDependencySchema = z.object({
  id: ulidSchema,
  task_id: ulidSchema,
  depends_on_task_id: ulidSchema,
  dependency_type: z.enum(DEPENDENCY_TYPES),
  created_at: timestampSchema,
});

export const insertTaskDependencySchema = selectTaskDependencySchema.omit({
  id: true,
  created_at: true,
});
