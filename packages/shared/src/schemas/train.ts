import { z } from "zod";

// ─── Enums ────────────────────────────────────────────────────────
// The train control state (design §4.1). First element ("running") matches the
// train_state.state column default in packages/server/src/db/schema.ts.
//   running ⇄ paused
// Adding a state means editing this one array (the DB column is plain `text`
// validated against this enum).
export const TRAIN_STATES = ["running", "paused"] as const;
export type TrainState = (typeof TRAIN_STATES)[number];

// ─── View shapes ──────────────────────────────────────────────────
// Full GET response shape for a train_state row (design §4.1 / §8.1). Field
// names mirror the Drizzle TS property names (camelCase) from
// packages/server/src/db/schema.ts §trainState. changedBy/reason/changedAt are
// null until the first pause/resume.
export const trainStateSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  resource: z.string(),
  state: z.enum(TRAIN_STATES),
  changedBy: z.string().nullable(),
  reason: z.string().nullable(),
  changedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TrainStateView = z.infer<typeof trainStateSchema>;
