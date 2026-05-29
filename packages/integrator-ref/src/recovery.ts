import type { Logger } from "./logger.js";
import type { PmClient } from "./pm-client.js";
import { isApiError, errMessage } from "./loop.js";

export interface ReclaimResult {
  scanned: number;
  reclaimed: number;
  skipped: number;
}

/**
 * Crash-recovery sweep (design §14.8). On startup, any request stuck in
 * `integrating` for this lane is reset back to `queued` so the lane unblocks.
 * resetToQueued internally cancels open attempts. A 409 means the request
 * already reached a terminal state (e.g. admin abandoned it during restart);
 * that's counted as skipped, not an error.
 */
export async function reclaimStrandedRequests(
  pmClient: PmClient,
  projectId: string,
  resource: string,
  logger: Logger,
): Promise<ReclaimResult> {
  let stranded;
  try {
    stranded = await pmClient.listMergeRequests(projectId, {
      resource,
      status: "integrating",
    });
  } catch (err) {
    logger.warn(
      { err: errMessage(err) },
      "Failed to list stranded requests during recovery",
    );
    return { scanned: 0, reclaimed: 0, skipped: 0 };
  }

  let reclaimed = 0;
  let skipped = 0;
  for (const req of stranded) {
    try {
      await pmClient.resetToQueued(
        req.id,
        "integrator restart; reclaiming stranded request",
      );
      reclaimed += 1;
      logger.info({ requestId: req.id }, "Reclaimed stranded request");
    } catch (err) {
      if (isApiError(err, 409)) {
        skipped += 1;
        logger.info(
          { requestId: req.id },
          "Stranded request already terminal; skipping",
        );
      } else {
        skipped += 1;
        logger.warn(
          { requestId: req.id, err: errMessage(err) },
          "Failed to reclaim stranded request",
        );
      }
    }
  }

  return { scanned: stranded.length, reclaimed, skipped };
}
