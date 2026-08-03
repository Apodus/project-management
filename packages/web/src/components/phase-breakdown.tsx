import { formatDurationMs, formatPercent } from "@/lib/format";
import { PHASE_BAR_COLOR, PHASE_LABEL, type PhaseName } from "@/lib/phases";
import { cn } from "@/lib/utils";

// ═══════════════════════════════════════════════════════════════════
// Phase-breakdown marks (campaign 2026-08-03 §P4).
//
// Pure and prop-driven — no queries, no page knowledge — because §P5's event
// trace renders the same three marks against the same taxonomy. Every one of
// them is honest about absence: a phase with no share is not a zero-width
// segment, it is simply not drawn.
// ═══════════════════════════════════════════════════════════════════

/** The minimum a mark needs to place a phase on a shared axis. */
export interface PhaseShareDatum {
  phase: PhaseName;
  /** null when the denominator was 0 — the phase stays in the table, off the bar. */
  share: number | null;
}

/**
 * The stacked share bar: one segment per phase, widths proportional to share.
 *
 * A11Y TRADE, deliberate: ONE `role="img"` with a sentence naming every segment
 * and its share, rather than seven focusable divs a screen-reader user would
 * tab through hearing nothing useful. The bar is a summary of the table below
 * it — the table carries every number, is fully navigable, and is never
 * collapsed into a hover-only affordance (it is also what relieves the one
 * light-mode contrast warning in this palette).
 */
export function PhaseShareBar({
  stats,
  ariaLabel,
}: {
  stats: readonly PhaseShareDatum[];
  ariaLabel: string;
}) {
  // A null share means "measured, but the denominator was 0" — it cannot be
  // placed on the bar, and drawing it as 0 would be the lie this panel exists
  // to avoid. It keeps its table row.
  const segments = stats.filter((s): s is PhaseShareDatum & { share: number } => s.share !== null);
  if (segments.length === 0) return null;

  // The bar's accessible name IS the enumeration, composed here rather than by
  // each caller, so the picture can never drift from the rows it summarizes.
  const description = segments
    .map((s) => `${PHASE_LABEL[s.phase]} ${formatPercent(s.share)}`)
    .join(", ");

  return (
    <div
      role="img"
      aria-label={`${ariaLabel}: ${description}`}
      className="flex h-4 w-full gap-[2px] overflow-hidden rounded"
    >
      {segments.map((s) => (
        <div
          key={s.phase}
          aria-hidden="true"
          data-phase={s.phase}
          data-testid="phase-segment"
          // `flex: <share> 1 0%`, NOT `width: <share>%`: with a 2px gap between
          // segments the gaps come out of the distributable space, so seven
          // percentage widths plus six gaps overflow the track. Growing from a
          // 0% basis divides exactly what is left. min-w keeps a present-but-
          // tiny phase a visible hairline rather than nothing at all.
          //
          // No in-segment text: seven segments guarantee clipped labels, and
          // there is no dependency-free way to measure whether one fits. Every
          // value is one line below in the table.
          style={{ flex: `${s.share} 1 0%` }}
          className={cn("min-w-[2px] rounded-[2px]", PHASE_BAR_COLOR[s.phase])}
        />
      ))}
    </div>
  );
}

/**
 * p50 as a bar from the baseline, p95 as a ringed dot, both on ONE axis shared
 * by every row — so verify's p50 visibly dwarfs land's instead of each row
 * self-normalizing to full width and every phase looking equally expensive.
 *
 * Decorative (`aria-hidden`): the p50 and p95 columns beside it carry the same
 * two numbers as text.
 */
export function PhaseSpreadMark({
  phase,
  p50Ms,
  p95Ms,
  axisMaxMs,
}: {
  phase: PhaseName;
  p50Ms: number;
  p95Ms: number;
  axisMaxMs: number;
}) {
  // axisMax is a SEEDED reduce upstream, never Math.max(...[]) — an empty
  // spread yields -Infinity and every width below becomes NaN. Guard anyway:
  // an all-zero window has no scale, so both marks collapse to the hairline.
  const scale = axisMaxMs > 0 ? axisMaxMs : null;
  const pct = (ms: number) => (scale ? Math.min(100, Math.max(0, (ms / scale) * 100)) : 0);

  return (
    <div
      aria-hidden="true"
      className="bg-muted/40 relative h-3 w-full min-w-[3.5rem] rounded-full"
      title={`p50 ${formatDurationMs(p50Ms)} · p95 ${formatDurationMs(p95Ms)}`}
    >
      <div
        style={{ width: `${pct(p50Ms)}%` }}
        className={cn(
          "absolute inset-y-[3px] left-0 min-w-[2px] rounded-full opacity-70",
          PHASE_BAR_COLOR[phase],
        )}
      />
      <div
        style={{ left: `${pct(p95Ms)}%` }}
        className={cn(
          "border-background absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2",
          PHASE_BAR_COLOR[phase],
        )}
      />
    </div>
  );
}

/**
 * One completed phase, as a chip: hue swatch, phase name (plus its step label
 * when the integrator named one), duration, and an optional muted note.
 */
export function PhaseChip({
  phase,
  durationMs,
  label,
  note,
  title,
}: {
  phase: PhaseName;
  durationMs: number;
  label?: string | null;
  note?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="bg-muted/40 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px]"
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", PHASE_BAR_COLOR[phase])} />
      <span>
        {PHASE_LABEL[phase]}
        {label ? ` · ${label}` : ""}
      </span>
      <span className="font-medium tabular-nums">{formatDurationMs(durationMs)}</span>
      {note && <span className="text-muted-foreground">{note}</span>}
    </span>
  );
}
