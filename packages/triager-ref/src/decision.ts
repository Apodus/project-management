/**
 * The triage decision contract (Campaign T2·P3).
 *
 * `decide()` (the injected assessment seam) PRODUCES a `TriageAssessment` — the
 * structured disposition an assessment session declared. P3 only PRODUCES the
 * decision; it does NOT execute it (the loop still ignores `decide()`'s return).
 * Execution / side-log recording / mode-gating is P4.
 *
 * The decision KIND reuses the shared `TriageDecisionKind` (the off/shadow/on
 * side-log contract T3 reads). The breakdown + confidence are triager-local
 * assessment metadata — not a shared wire contract — so they live in this
 * package. `parseAssessmentSentinel` is the pure, NEVER-throwing parser of the
 * status-sentinel JSON the assessment session writes; the runner uses it under a
 * strict fail-safe precedence (a verdict it cannot trust ⇒ a failed session,
 * NEVER a fabricated promote/dismiss).
 */
import type { TriageDecisionKind } from "@pm/shared";
import { TRIAGE_DECISION_KINDS } from "@pm/shared";

/** A single suggested epic/task in a fast-track breakdown. */
export interface TriageBreakdownItem {
  title: string;
  description?: string;
}

/**
 * The fast-track breakdown SUGGESTION. Tasks are required (non-empty); epics are
 * optional. This is advisory metadata on a PROPOSAL the daemon mints — the
 * triager NEVER mints tasks directly (the proposal-gate is untouched).
 */
export interface TriageBreakdown {
  epics?: TriageBreakdownItem[];
  tasks: TriageBreakdownItem[];
}

/**
 * The structured disposition an assessment session declared. `kind` is the shared
 * decision contract; `rationale`/`confidence` are always present (confidence in
 * [0,1]); `breakdown` is present only for `promote_fast_track`.
 */
export interface TriageAssessment {
  kind: TriageDecisionKind;
  rationale: string;
  confidence: number;
  breakdown?: TriageBreakdown;
}

/** A fast-track breakdown is capped at this many tasks (a minimal seed). */
export const MAX_FAST_TRACK_TASKS = 3;

/** Clamp an arbitrary value into [0,1]; NaN/null/array/out-of-range ⇒ 0. */
function clamp01(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Coerce one raw breakdown entry to a `TriageBreakdownItem`, or undefined. */
function parseItem(raw: unknown): TriageBreakdownItem | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const o = raw as { title?: unknown; description?: unknown };
  if (typeof o.title !== "string" || o.title.length === 0) return undefined;
  const item: TriageBreakdownItem = { title: o.title };
  if (typeof o.description === "string") item.description = o.description;
  return item;
}

/** Coerce a raw array (capped) into `TriageBreakdownItem[]`. */
function parseItems(raw: unknown, cap: number): TriageBreakdownItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TriageBreakdownItem[] = [];
  for (const entry of raw) {
    const item = parseItem(entry);
    if (item) out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Parse the assessment status-sentinel JSON into a `TriageAssessment`. NEVER
 * throws — any malformed input returns `undefined` (the runner maps that to a
 * failed session). The contract:
 *   - `status` MUST be one of TRIAGE_DECISION_KINDS, else ⇒ undefined.
 *   - `rationale` ⇒ String(parsed.rationale ?? "").
 *   - `confidence` ⇒ clamp01 (NaN/null/array/out-of-range ⇒ 0).
 *   - For `promote_fast_track`: parse `breakdown.tasks` (cap MAX_FAST_TRACK_TASKS,
 *     optional epics). If tasks missing/empty ⇒ DOWNGRADE kind to
 *     `promote_standard` and drop the breakdown (we never fabricate a breakdown).
 */
export function parseAssessmentSentinel(raw: string): TriageAssessment | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const o = parsed as {
    status?: unknown;
    rationale?: unknown;
    confidence?: unknown;
    breakdown?: unknown;
  };
  const status = o.status;
  if (typeof status !== "string") return undefined;
  if (!(TRIAGE_DECISION_KINDS as readonly string[]).includes(status)) return undefined;
  const kind = status as TriageDecisionKind;

  const rationale = String(o.rationale ?? "");
  const confidence = clamp01(o.confidence);

  if (kind === "promote_fast_track") {
    const bd = o.breakdown;
    const bdObj = bd !== null && typeof bd === "object" ? (bd as Record<string, unknown>) : {};
    const tasks = parseItems(bdObj.tasks, MAX_FAST_TRACK_TASKS);
    if (tasks.length === 0) {
      // No usable breakdown — downgrade to a standard promotion (never fabricate).
      return { kind: "promote_standard", rationale, confidence };
    }
    const breakdown: TriageBreakdown = { tasks };
    const epics = parseItems(bdObj.epics, MAX_FAST_TRACK_TASKS);
    if (epics.length > 0) breakdown.epics = epics;
    return { kind, rationale, confidence, breakdown };
  }

  return { kind, rationale, confidence };
}
