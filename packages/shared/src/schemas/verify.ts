import { z } from "zod";
import { VERIFY_RESULTS } from "../constants/enums.js";

// ═══════════════════════════════════════════════════════════════════
// Phase 7.5 smart-verification wire schemas (design §3.1, §5.2, §7.3).
//
// The verify-step DAG schema (verifyStepSchema + the VerifyStep type) lives in
// schemas/project.ts — its .superRefine DAG validation is chained inline onto
// integratorSettingsSchema, so the schema CANNOT move out without losing that
// chain. The VerifyStep type is re-exported here so consumers (Step 3/7) import
// the verify shapes from one place.
//
// View convention mirrors trainStateSchema / observability.ts: z.string() ids +
// ISO timestamps, .nullable() for null-until-first columns, camelCase on the
// wire. The server routes carry structurally-identical Zod-4 mirrors — never
// import these Zod-3 schemas into a route.
// ═══════════════════════════════════════════════════════════════════

export type { VerifyStep } from "./project.js";

// ─── verify_cache row view (§3.1) ─────────────────────────────────
// Full GET response shape for a verify_cache row (the debug cache GET, §8.4).
// Field names mirror the Drizzle TS property names (camelCase) of the §3.1
// verifyCache table. durationMs/logExcerpt/logUrl are nullable columns;
// lastHitAt is null until the row first serves a hit.
export const verifyCacheRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  resource: z.string(),
  treeSha: z.string(),
  stepId: z.string(),
  stepConfigSha: z.string(),
  result: z.enum(VERIFY_RESULTS),
  durationMs: z.number().nullable(),
  logExcerpt: z.string().nullable(),
  logUrl: z.string().nullable(),
  createdAt: z.string(),
  lastHitAt: z.string().nullable(),
  hitCount: z.number(),
  updatedAt: z.string(),
});
export type VerifyCacheRowView = z.infer<typeof verifyCacheRowSchema>;

// ─── per-step pipeline result (§5.2 / §7.3) ───────────────────────
// One verify step's outcome, surfaced in the per-request timeline / dashboard.
// cached: true if a cache hit served the verdict (no run). durationMs is ~0 on a
// hit, the real run duration on a miss. logUrl is optional (a pure hit has none).
export const verifyStepResultSchema = z.object({
  stepId: z.string(),
  outcome: z.enum(VERIFY_RESULTS),
  cached: z.boolean(),
  durationMs: z.number(),
  treeSha: z.string(),
  stepConfigSha: z.string(),
  logUrl: z.string().optional(),
});
export type VerifyStepResult = z.infer<typeof verifyStepResultSchema>;
