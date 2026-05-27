import { z } from "zod";
import { USER_ROLES, USER_TYPES } from "../constants/enums.js";
import { ulidSchema, timestampSchema, optionalText } from "./common.js";

export const selectUserSchema = z.object({
  id: ulidSchema,
  username: z.string().min(1),
  display_name: z.string().min(1),
  email: optionalText,
  role: z.enum(USER_ROLES),
  type: z.enum(USER_TYPES),
  avatar_url: optionalText,
  password_hash: z.string().nullable().optional(),
  api_token_hash: z.string().nullable().optional(),
  is_active: z.boolean(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export const insertUserSchema = selectUserSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});
