import { ViewportPortal } from "@xyflow/react";
import type { TimeScale } from "@/lib/epic-graph-layout";
import type { Milestone } from "@/lib/api";

/**
 * Presentational milestone vertical guides + a "today" line, rendered INSIDE
 * <ReactFlow> via <ViewportPortal> so the guides live in flow coordinates and
 * pan/zoom together with the graph.
 *
 * Pure render from props: each milestone with a parseable `targetDate` becomes
 * a dashed vertical at `scale.toX(targetDate)` (off-canvas guides are culled);
 * `scale.nowMs` becomes a distinct solid "Today" line. x is the flow-space x
 * the layout assigned to that timestamp, so the guides align with the nodes.
 */

interface MilestoneGuidesProps {
  scale: TimeScale;
  milestones: Milestone[];
  yTop: number;
  ySpan: number;
}

// Short, locale-stable date label for a guide pill (e.g. "Jun 2").
function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function MilestoneGuides({ scale, milestones, yTop, ySpan }: MilestoneGuidesProps) {
  // A guide is visible if its x falls within the time domain plus a small
  // margin (a milestone just off the padded edge is still worth a hint).
  const minX = scale.xPad - 40;
  const maxX = scale.width - scale.xPad + 40;

  const guides = milestones
    .map((m) => {
      if (m.targetDate == null) return null;
      const ms = Date.parse(m.targetDate);
      if (Number.isNaN(ms)) return null;
      const x = scale.toX(ms);
      if (x < minX || x > maxX) return null;
      return { id: m.id, name: m.name, x, label: shortDate(ms) };
    })
    .filter((g): g is { id: string; name: string; x: number; label: string } => g !== null);

  const todayX = scale.toX(scale.nowMs);
  const todayVisible = todayX >= minX && todayX <= maxX;

  return (
    <ViewportPortal>
      {guides.map((g) => (
        <div
          key={g.id}
          className="border-muted-foreground/40 pointer-events-none absolute border-l border-dashed"
          style={{ left: g.x, top: yTop, height: ySpan }}
        >
          <div className="text-muted-foreground bg-background/80 absolute left-1 top-0 max-w-[160px] truncate whitespace-nowrap rounded px-1 py-0.5 text-[10px]">
            {g.name} · {g.label}
          </div>
        </div>
      ))}

      {todayVisible && (
        <div
          className="border-primary pointer-events-none absolute border-l"
          style={{ left: todayX, top: yTop, height: ySpan }}
        >
          <div className="bg-primary text-primary-foreground absolute left-1 top-0 whitespace-nowrap rounded px-1 py-0.5 text-[10px]">
            Today
          </div>
        </div>
      )}
    </ViewportPortal>
  );
}
