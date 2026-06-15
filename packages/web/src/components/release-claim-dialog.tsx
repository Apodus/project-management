import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useReleaseClaim } from "@/hooks/use-claims";
import type { ClaimItem } from "@/lib/api";

// ─── Release-claim dialog (plain release) ─────────────────────────
// Clears the holder and tears down the lease — the operator's "just let go of
// this dead claim" action. No target, no reason (vs release-to /
// request-takeover): a human may release ANY claim outright.

export function ReleaseClaimDialog({
  item,
  open,
  onOpenChange,
}: {
  item: ClaimItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const releaseMutation = useReleaseClaim();

  async function handleSubmit() {
    try {
      await releaseMutation.mutateAsync({
        entityType: item.entityType,
        id: item.id,
      });
      onOpenChange(false);
    } catch {
      // The hook's onError toast surfaces the backend message.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Release claim</DialogTitle>
          <DialogDescription>
            Release the claim on &ldquo;{item.title}&rdquo;. The holder is
            cleared and the lease is torn down, returning the item to the
            unclaimed pool. Use this for a claim whose agent has shut down.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={releaseMutation.isPending}>
            {releaseMutation.isPending ? "Releasing…" : "Release claim"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
