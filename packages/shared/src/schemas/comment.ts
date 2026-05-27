import { z } from "zod";
import { COMMENT_TYPES } from "../constants/enums.js";
import { ulidSchema, timestampSchema } from "./common.js";

export const progressUpdateMetadataSchema = z.object({
  completion_pct: z.number().min(0).max(100),
  files_changed: z.array(z.string()).optional(),
  summary: z.string().optional(),
});

export const decisionMetadataSchema = z.object({
  decision: z.string(),
  rationale: z.string(),
  alternatives_considered: z.array(z.string()).optional(),
});

export const handoffMetadataSchema = z.object({
  summary: z.string(),
  files_changed: z.array(z.string()).optional(),
  open_questions: z.array(z.string()).optional(),
  test_results: z.string().optional(),
});

export const commentMetadataSchema = z
  .union([progressUpdateMetadataSchema, decisionMetadataSchema, handoffMetadataSchema])
  .nullable()
  .optional();

export const selectCommentSchema = z.object({
  id: ulidSchema,
  task_id: ulidSchema.nullable().optional(),
  proposal_id: ulidSchema.nullable().optional(),
  author_id: ulidSchema,
  body: z.string().min(1),
  comment_type: z.enum(COMMENT_TYPES),
  metadata: commentMetadataSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export const insertCommentSchema = selectCommentSchema.omit({
  id: true,
  created_at: true,
  updated_at: true,
});
