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
      // §9 finding 2: a GROUPED stranded member is recovered as a whole group by
      // reclaimStrandedGroups (group + members reset atomically). Resetting one
      // grouped member here would desync it from its group, so exclude grouped
      // members — single-repo stranded requests only.
      ungrouped: true,
    });
  } catch (err) {
    logger.warn({ err: errMessage(err) }, "Failed to list stranded requests during recovery");
    return { scanned: 0, reclaimed: 0, skipped: 0 };
  }

  let reclaimed = 0;
  let skipped = 0;
  for (const req of stranded) {
    try {
      await pmClient.resetToQueued(req.id, "integrator restart; reclaiming stranded request");
      reclaimed += 1;
      logger.info({ requestId: req.id }, "Reclaimed stranded request");
    } catch (err) {
      if (isApiError(err, 409)) {
        skipped += 1;
        logger.info({ requestId: req.id }, "Stranded request already terminal; skipping");
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

/**
 * Stranded-GROUP recovery sweep (design §9 finding 2 / §6.4). On integrator
 * restart, a cross-repo merge group left `integrating` by a crash must be reset
 * to a re-integratable state — but ONLY if it is a genuinely-stranded group, NOT
 * a real orphan.
 *
 * The discriminator is the open `orphaned_inner` incident (the SOLE durable
 * record of a real orphan, §7.2). For each `integrating` group:
 *   - NO open incident → the §6.4 crash-between-PUSH-1-and-incident-write
 *     window: the inner may have pushed but PM never recorded an orphan, so the
 *     whole group is reset to `forming` (resetGroup, atomic group+members) and
 *     re-integrated on the next pass — the inner re-push is a ff no-op, the
 *     outer push completes the atom.
 *   - an OPEN incident → a REAL orphan (§6.5 ran). LEAVE it untouched: the §7
 *     opportunistic rollforward (recoverOrphanedInner) handles it. Resetting it
 *     would corrupt the atom.
 *
 * A `partially_landed` group is never even listed here (we list state=integrating
 * only); and the server-side resetGroup guard refuses it as a second fence.
 *
 * A 409 from resetGroup (e.g. the group raced to a terminal/partial state, or an
 * incident appeared between our list and the reset) is counted as skipped, not
 * an error — mirrors reclaimStrandedRequests.
 */
export async function reclaimStrandedGroups(
  pmClient: PmClient,
  projectId: string,
  resource: string,
  logger: Logger,
): Promise<ReclaimResult> {
  let stranded;
  try {
    stranded = await pmClient.listMergeGroups(projectId, {
      resource,
      state: "integrating",
    });
  } catch (err) {
    logger.warn({ err: errMessage(err) }, "Failed to list stranded groups during recovery");
    return { scanned: 0, reclaimed: 0, skipped: 0 };
  }

  let reclaimed = 0;
  let skipped = 0;
  for (const group of stranded) {
    // Discriminate: a real orphan (open incident) is left for §7 rollforward.
    let openIncidents;
    try {
      openIncidents = await pmClient.listMergeIncidents(projectId, {
        state: "open",
        type: "orphaned_inner",
        groupId: group.id,
      });
    } catch (err) {
      // Could not check — be conservative and LEAVE the group (do not risk
      // resetting a real orphan). Count as skipped; the next restart retries.
      skipped += 1;
      logger.warn(
        { groupId: group.id, err: errMessage(err) },
        "Failed to check incidents for stranded group; leaving it untouched",
      );
      continue;
    }
    if (openIncidents.length > 0) {
      skipped += 1;
      logger.info(
        { groupId: group.id, incidentCount: openIncidents.length },
        "Stranded group has an open incident; leaving it for orphan recovery (§7)",
      );
      continue;
    }

    // No open incident → the §6.4 stranded case. Reset the whole group.
    try {
      await pmClient.resetGroup(group.id, {
        reason: "integrator restart; reclaiming stranded group (§6.4 window)",
      });
      reclaimed += 1;
      logger.info({ groupId: group.id }, "Reset stranded group to forming for re-integration");
    } catch (err) {
      skipped += 1;
      if (isApiError(err, 409)) {
        logger.info(
          { groupId: group.id },
          "Stranded group could not be reset (raced to terminal/incident); skipping",
        );
      } else {
        logger.warn({ groupId: group.id, err: errMessage(err) }, "Failed to reset stranded group");
      }
    }
  }

  return { scanned: stranded.length, reclaimed, skipped };
}
