import { z } from "zod";
import { GIT_REF_TYPES, GIT_REF_STATUSES } from "../constants/enums.js";
import { ulidSchema, timestampSchema, optionalText } from "./common.js";

export const selectGitRefSchema = z.object({
  id: ulidSchema,
  task_id: ulidSchema,
  ref_type: z.enum(GIT_REF_TYPES),
  ref_value: z.string().min(1),
  url: optionalText,
  title: optionalText,
  status: z.enum(GIT_REF_STATUSES).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  created_at: timestampSchema,
});

export const insertGitRefSchema = selectGitRefSchema.omit({
  id: true,
  created_at: true,
});
