import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useUsers } from "@/hooks/use-users";
import { useReleaseClaimTo } from "@/hooks/use-claims";
import { ApiError, type ClaimItem } from "@/lib/api";

// ─── Release-to dialog (Campaign C3 — claim handoff) ──────────────
// Hand a claim to a NAMED worker. The current holder (or any human) may
// release; the lease transfers to the target. This is a direct transfer of the
// holder's own claim — it never stomps someone ELSE'S live claim.

export function ReleaseToDialog({
  item,
  open,
  onOpenChange,
}: {
  item: ClaimItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [targetId, setTargetId] = useState("");
  const [reason, setReason] = useState("");
  const releaseMutation = useReleaseClaimTo();
  const { data: users, error: usersError } = useUsers();

  // Listing workers is admin-only — a non-admin gets a 403. Render an inline
  // notice instead of crashing (the dialog stays usable for cancel).
  const usersForbidden =
    usersError instanceof ApiError && usersError.status === 403;

  // Offer active workers other than the current holder.
  const candidates = (users ?? []).filter(
    (u) => u.isActive && u.id !== item.holder.id,
  );

  function reset() {
    setTargetId("");
    setReason("");
    releaseMutation.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const canSubmit = targetId.trim().length > 0 && reason.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    try {
      await releaseMutation.mutateAsync({
        entityType: item.entityType,
        id: item.id,
        targetId,
        reason: reason.trim(),
      });
      handleOpenChange(false);
    } catch {
      // The hook's onError toast surfaces the backend message.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Release claim to another worker</DialogTitle>
          <DialogDescription>
            Hand &ldquo;{item.title}&rdquo; (currently held by {item.holder.name}) to a
            named worker. The transfer is audited and the claim lease moves to
            the new holder. A reason is required.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="release-to-target">Target worker</Label>
            {usersForbidden ? (
              <p className="text-sm text-muted-foreground">
                Listing workers requires admin access — ask an admin to perform
                this handoff, or use request-takeover from the target worker.
              </p>
            ) : (
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger id="release-to-target" className="w-full">
                  <SelectValue placeholder="Select a worker" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      <span>{u.displayName}</span>
                      {u.type === "ai_agent" && (
                        <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0">
                          AI
                        </Badge>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="release-to-reason">Reason</Label>
            <Textarea
              id="release-to-reason"
              placeholder="holder is offline; rebalancing work…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit || releaseMutation.isPending}
          >
            {releaseMutation.isPending ? "Transferring…" : "Release claim"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
