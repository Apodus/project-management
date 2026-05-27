import { z } from "zod";
import { ENTITY_TYPES, ACTIVITY_ACTIONS } from "../constants/enums.js";
import { ulidSchema, timestampSchema } from "./common.js";

export const activityChangesSchema = z.record(
  z.string(),
  z.object({
    from: z.unknown(),
    to: z.unknown(),
  }),
);

export const selectActivityLogSchema = z.object({
  id: ulidSchema,
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: ulidSchema,
  project_id: ulidSchema,
  actor_id: ulidSchema,
  action: z.enum(ACTIVITY_ACTIONS),
  changes: activityChangesSchema.nullable().optional(),
  created_at: timestampSchema,
});

export const insertActivityLogSchema = selectActivityLogSchema.omit({
  id: true,
  created_at: true,
});
