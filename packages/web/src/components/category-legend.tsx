import { Panel } from "@xyflow/react";
import { cn } from "@/lib/utils";

// A compact top-left legend card listing the epic categories present in the
// current roadmap. Each row is a toggle: clicking it hides/shows that category's
// epics on the DAG. The swatch always shows the category's full color (even when
// hidden); the label gets struck through + faded while hidden. The Uncategorized
// row (no color) falls back to the muted-foreground token.
export function CategoryLegend({
  rows,
  hidden,
  onToggle,
  frontierRow,
}: {
  rows: { key: string; name: string; color?: string }[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
  // R2: an optional static (non-toggle) row keying the now-frontier emerald
  // ready-ring. Rendered below the category rows; lets the legend mount for an
  // uncategorized roadmap that still has a frontier to explain.
  frontierRow?: { label: string };
}) {
  // Mount when there's anything to show — category rows OR the frontier key.
  if (rows.length === 0 && !frontierRow) return null;

  return (
    <Panel position="top-left">
      <div className="bg-card/90 flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs shadow-sm">
        {rows.map((row) => {
          const isHidden = hidden.has(row.key);
          return (
            <button
              key={row.key}
              type="button"
              aria-pressed={!isHidden}
              onClick={() => onToggle(row.key)}
              className="flex items-center gap-1.5 text-left"
            >
              <span
                className="size-3 rounded-[3px]"
                style={{ backgroundColor: row.color ?? "var(--muted-foreground)" }}
              />
              <span className={cn("truncate", isHidden && "line-through opacity-50")}>
                {row.name}
              </span>
            </button>
          );
        })}
        {frontierRow && (
          // Static (non-button) key for the now-frontier. The swatch is a RING
          // (matching the node's emerald ready-ring), NOT a filled category
          // square, so it reads as "a treatment" rather than "a category".
          <div className="flex items-center gap-1.5 text-left">
            <span className="size-3 rounded-[3px] ring-1 ring-emerald-500/60" />
            <span className="truncate">{frontierRow.label}</span>
          </div>
        )}
      </div>
    </Panel>
  );
}
