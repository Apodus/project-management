import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { useRequestClaimTakeover } from "@/hooks/use-claims";
import type { ClaimItem } from "@/lib/api";

// ─── Request-takeover dialog (Campaign C3 — stomp-safe handoff) ───
// A STALE (lease-lapsed) claim is auto-granted to you. A LIVE claim is NEVER
// taken over — the holder is only notified and the claim is left unchanged
// (the cardinal invariant). The copy states both outcomes up front.

export function RequestTakeoverDialog({
  item,
  open,
  onOpenChange,
}: {
  item: ClaimItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [reason, setReason] = useState("");
  const takeoverMutation = useRequestClaimTakeover();

  function reset() {
    setReason("");
    takeoverMutation.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const canSubmit = reason.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    try {
      await takeoverMutation.mutateAsync({
        entityType: item.entityType,
        id: item.id,
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
          <DialogTitle>Request takeover</DialogTitle>
          <DialogDescription>
            Ask to take over &ldquo;{item.title}&rdquo;. If the claim is{" "}
            <span className="font-medium">stale</span> (lease lapsed) it is transferred to you
            immediately. If it is <span className="font-medium">live</span>, the holder is notified
            and the claim is NOT changed — live claims are never taken over.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="takeover-reason">Reason</Label>
          <Textarea
            id="takeover-reason"
            placeholder="holder appears inactive; picking up abandoned work…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || takeoverMutation.isPending}>
            {takeoverMutation.isPending ? "Requesting…" : "Request takeover"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
