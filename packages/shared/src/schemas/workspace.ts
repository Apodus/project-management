import { z } from "zod";
import { ulidSchema, timestampSchema, optionalText } from "./common.js";

export const workspaceSettingsSchema = z
  .object({})
  .passthrough()
  .nullable()
  .optional();

export const selectWorkspaceSchema = z.object({
  id: ulidSchema,
  name: z.string().min(1),
  description: optionalText,
  settings: workspaceSettingsSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export const insertWorkspaceSchema = selectWorkspaceSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});
