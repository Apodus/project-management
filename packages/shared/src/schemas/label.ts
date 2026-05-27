import { z } from "zod";
import { ulidSchema, optionalText } from "./common.js";

export const selectLabelSchema = z.object({
  id: ulidSchema,
  project_id: ulidSchema,
  name: z.string().min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color code"),
  description: optionalText,
});

export const insertLabelSchema = selectLabelSchema.omit({
  id: true,
});
