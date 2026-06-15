import { AlertTriangle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getClaimStateStyle } from "@/lib/format";
import type { Task } from "@/lib/api";

interface ClaimStateBadgeProps {
  state: Task["claimState"];
  className?: string;
}

/**
 * Surface claim liveness (live / stale / yours / unclaimed) as a soft-tint badge.
 *
 * Renders NOTHING for `unclaimed` (no claim to report). `stale` gets an
 * AlertTriangle so a lapsed lease pops on dense views (board cards, the
 * roadmap DAG); `live` is intentionally quiet so stale stays dominant.
 *
 * The switch is exhaustive — typecheck enforces coverage of every CLAIM_STATE.
 */
export function ClaimStateBadge({ state, className }: ClaimStateBadgeProps) {
  switch (state) {
    case "stale":
      return (
        <Badge className={cn(getClaimStateStyle(state), className)}>
          <AlertTriangle className="size-3" />
          Stale
        </Badge>
      );
    case "live":
      return <Badge className={cn(getClaimStateStyle(state), className)}>Live</Badge>;
    case "yours":
      return <Badge className={cn(getClaimStateStyle(state), className)}>Yours</Badge>;
    case "unclaimed":
      return null;
    default: {
      // Exhaustiveness guard — a new CLAIM_STATE must be handled above.
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
