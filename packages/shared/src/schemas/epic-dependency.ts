import { z } from "zod";
import { DEPENDENCY_TYPES } from "../constants/enums.js";
import { ulidSchema, timestampSchema } from "./common.js";

export const selectEpicDependencySchema = z.object({
  id: ulidSchema,
  project_id: ulidSchema,
  epic_id: ulidSchema,
  depends_on_epic_id: ulidSchema,
  dependency_type: z.enum(DEPENDENCY_TYPES),
  created_at: timestampSchema,
  created_by: ulidSchema, // required in Zod, matches selectEpicSchema precedent (DB column is nullable)
});

export const insertEpicDependencySchema = selectEpicDependencySchema.omit({
  id: true,
  created_at: true,
});
