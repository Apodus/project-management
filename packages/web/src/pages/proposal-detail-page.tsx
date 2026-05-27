import { useParams } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function ProposalDetailPage() {
  const { proposalId } = useParams({ strict: false });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <FileText className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">Proposal Detail</h1>
      </div>
      {proposalId && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Proposal ID:</span>
          <Badge variant="secondary">
            <code className="font-mono text-xs">{proposalId}</code>
          </Badge>
        </div>
      )}
      <p className="text-muted-foreground">
        Proposal detail view will be implemented in Step 11 (data fetching).
      </p>
    </div>
  );
}
