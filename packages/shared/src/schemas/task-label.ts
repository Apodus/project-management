import { z } from "zod";
import { ulidSchema } from "./common.js";

/**
 * task_labels is a pure join table: composite PK of (task_id, label_id).
 * No id column, no timestamps.
 */
export const taskLabelSchema = z.object({
  task_id: ulidSchema,
  label_id: ulidSchema,
});
