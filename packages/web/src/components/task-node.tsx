import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import { getStatusColor, formatStatus } from "@/lib/format";

export interface TaskNodeData {
  title: string;
  status: string;
  type: string;
  assigneeId: string | null;
  [key: string]: unknown;
}

export type TaskFlowNode = Node<TaskNodeData, "task">;

// Initials from an assignee id/name for the corner chip (best-effort; ids may
// not be human names — this is a compact affordance, not authoritative).
function initials(assigneeId: string): string {
  const parts = assigneeId
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function TaskNodeComponent({ data }: NodeProps<TaskFlowNode>) {
  const { title, status, assigneeId } = data;

  return (
    <div className="bg-card relative w-[180px] cursor-pointer rounded-md border px-3 py-2 shadow-sm">
      {/* Required for edges to attach; visually unobtrusive. */}
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />

      <div className="line-clamp-2 text-sm font-medium">{title}</div>
      <div className="mt-1.5 flex items-center justify-between gap-1">
        <Badge className={getStatusColor(status)}>{formatStatus(status)}</Badge>
        {assigneeId && (
          <span
            className="bg-muted text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium"
            title={assigneeId}
          >
            {initials(assigneeId)}
          </span>
        )}
      </div>
    </div>
  );
}

export const TaskNode = memo(TaskNodeComponent);
