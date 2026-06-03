import { ViewportPortal } from "@xyflow/react";
import type { TrayRegion } from "@/lib/epic-graph-layout";

/**
 * Presentational divider + label for the structure-mode "Independent (no
 * dependencies)" tray, rendered INSIDE <ReactFlow> via <ViewportPortal> (a bare
 * child, mirroring MilestoneGuides) so it lives in flow coordinates and
 * pans/zooms with the graph. Pure render from the tray bbox the layout exposes.
 */
export function EpicTrayLabel({ tray }: { tray: TrayRegion }) {
  const width = Math.max(tray.rightX - tray.leftX, 0);
  return (
    <ViewportPortal>
      <div
        className="border-muted-foreground/40 pointer-events-none absolute border-t border-dashed"
        style={{ left: tray.leftX, top: tray.topY - 28, width }}
      >
        <div className="text-muted-foreground bg-background/80 absolute left-0 top-1 whitespace-nowrap rounded px-1 py-0.5 text-[10px]">
          Independent (no dependencies) · {tray.count}
        </div>
      </div>
    </ViewportPortal>
  );
}
