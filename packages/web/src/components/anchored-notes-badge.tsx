import { Link } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useNotes } from "@/hooks/use-notes";

/**
 * A small linked badge surfacing the count of OPEN notes anchored to a given
 * entity (task / epic / proposal), shown on that entity's detail page. Clicking
 * deep-links into the Inbox pre-filtered to this anchor.
 *
 * Lazy: one filtered list query per detail page (the (anchorType, anchorId)
 * index makes it cheap — no N+1). useNotes already gates on `enabled: !!projectId`,
 * so a null/undefined projectId → no query → count 0 → null render.
 */
export function AnchoredNotesBadge({
  projectId,
  anchorType,
  anchorId,
}: {
  projectId?: string;
  anchorType: "task" | "epic" | "proposal";
  anchorId: string;
}) {
  const { data } = useNotes(projectId, { anchorType, anchorId, status: "open" });
  const count = data?.data.length ?? 0;
  if (count === 0) return null;
  return (
    <Link
      to="/projects/$projectId/notes"
      params={{ projectId: projectId! }}
      search={{ anchorType, anchorId, status: "open" }}
    >
      <Badge variant="secondary">
        <Inbox className="mr-1 size-3" />
        {count} open finding{count === 1 ? "" : "s"} reference this
      </Badge>
    </Link>
  );
}
