import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { getHealthColor } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EpicGraphNode } from "@/lib/api";

// byStatus vocabulary + colors, mirrored from dashboard-page's task bar chart
// (module-local there). The hover underline segments completion by task status.
const STATUS_ORDER = ["backlog", "ready", "in_progress", "in_review", "done", "cancelled"] as const;

const STATUS_BAR_COLORS: Record<string, string> = {
  backlog: "bg-gray-400 dark:bg-gray-500",
  ready: "bg-blue-500 dark:bg-blue-400",
  in_progress: "bg-amber-500 dark:bg-amber-400",
  in_review: "bg-indigo-500 dark:bg-indigo-400",
  done: "bg-green-500 dark:bg-green-400",
  cancelled: "bg-red-400 dark:bg-red-500",
};

export interface EpicNodeData {
  name: string;
  done: number;
  total: number;
  progressPct: number;
  health: EpicGraphNode["health"];
  byStatus: Record<string, number>;
  dimmed?: boolean;
  inCycle?: boolean;
  recede?: number;
  [key: string]: unknown;
}

export type EpicFlowNode = Node<EpicNodeData, "epic">;

function EpicNodeComponent({ data }: NodeProps<EpicFlowNode>) {
  const { name, done, total, progressPct, health, byStatus, dimmed, inCycle, recede } = data;
  const statusSum = STATUS_ORDER.reduce((acc, s) => acc + (byStatus[s] ?? 0), 0);

  return (
    <div
      className={cn(
        "bg-card group relative w-[200px] overflow-hidden rounded-md border",
        // ALWAYS-ON opacity transition. This is the anti-flicker fix: the
        // transition must be unconditional so the browser only ever drives the
        // CURRENT opacity toward the TARGET (set in `style` below). A conditional
        // transition class (only-while-dimmed) was being added/removed as the
        // hover target flapped — and every time it dropped, the current opacity
        // SNAPPED (reset), which read as a flicker while the mouse swept across
        // nodes. With the transition always present, a flapping target merely
        // redirects the in-flight interpolation; current state is never reset.
        "transition-opacity duration-150",
        inCycle && "ring-2 ring-red-500",
      )}
      // SINGLE opacity source = the target. dimmed (chain-off) -> 0.25; else the
      // recency fade. The browser interpolates current -> this, both directions.
      style={{ opacity: dimmed ? 0.25 : (recede ?? 1) }}
    >
      {/* Required for edges to attach; visually unobtrusive. */}
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />

      {/* Completion fill: width = progress%, colored by health. */}
      <div
        data-testid="epic-node-fill"
        className={cn("absolute inset-y-0 left-0 opacity-70", getHealthColor(health, "fill"))}
        style={{ width: `${progressPct}%` }}
      />

      {/* Content sits above the fill. */}
      <div className="relative z-10 px-3 py-2">
        <div className="line-clamp-1 text-sm font-medium">{name}</div>
        <div className="text-muted-foreground flex items-center justify-between text-xs">
          <span>
            {done}/{total}
          </span>
          <span>{progressPct}%</span>
        </div>
      </div>

      {/* Hover underline: byStatus-segmented. Hidden when there are no tasks. */}
      <div className="relative z-10 flex h-1 w-full opacity-0 transition-opacity group-hover:opacity-100">
        {statusSum > 0 &&
          STATUS_ORDER.map((status) => {
            const count = byStatus[status] ?? 0;
            if (count === 0) return null;
            return (
              <div
                key={status}
                className={STATUS_BAR_COLORS[status]}
                style={{ width: `${(count / statusSum) * 100}%` }}
              />
            );
          })}
      </div>
    </div>
  );
}

export const EpicNode = memo(EpicNodeComponent);
