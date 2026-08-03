/**
 * A test probe over the REAL PhaseRecorder (campaign 2026-08-03 §P2).
 *
 * Deliberately not a hand-rolled PhaseSpans stub: the rows these tests assert on
 * are the rows that would go over the wire, normalization and all, so a bug in
 * the recorder cannot hide behind a friendlier fake.
 *
 * Not a `*.test.ts`, so vitest's default include glob does not collect it.
 */
import { createPhaseRecorder, type PhaseRecorder } from "../src/phase-recorder.js";
import type { PmClient } from "../src/pm-client.js";

export interface PhaseRow {
  phase: string;
  label: string | null;
  startedAt: string;
  durationMs: number;
  detail?: Record<string, unknown> | null;
  requestId?: string;
  groupId?: string;
  attemptId?: string;
}

export interface PhaseProbe {
  recorder: PhaseRecorder;
  /** Every row shipped so far (flushes first, so a caller never forgets to). */
  rows(): PhaseRow[];
  /** `phase/label` pairs, deduped + sorted — the span-coverage view. */
  labels(): string[];
  /** How many POSTs were launched. */
  postCount(): number;
}

/**
 * @param behavior "ok" (default), or "throw" to prove a broken ingest changes
 * nothing about the operation being measured.
 */
export function makePhaseProbe(behavior: "ok" | "throw" = "ok"): PhaseProbe {
  const posts: PhaseRow[][] = [];
  const pmClient = {
    postMergePhases(_projectId: string, body: { resource: string; phases: PhaseRow[] }) {
      posts.push(body.phases);
      if (behavior === "throw") throw new Error("phase ingest exploded");
      return Promise.resolve({ recorded: body.phases.length, adjusted: 0 });
    },
  } as unknown as Pick<PmClient, "postMergePhases">;

  const recorder = createPhaseRecorder({
    pmClient,
    projectId: "proj-1",
    resource: "main",
    logger: { warn: () => {} },
  });

  const rows = (): PhaseRow[] => {
    recorder.flush();
    return posts.flat();
  };

  return {
    recorder,
    rows,
    labels: () => [...new Set(rows().map((r) => `${r.phase}/${r.label ?? "-"}`))].sort(),
    postCount: () => {
      recorder.flush();
      return posts.length;
    },
  };
}
