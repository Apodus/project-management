-- Backfill claim_leases for legacy claimed-but-leaseless entities.
--
-- Every agent claim has created a lease since the lease engine shipped, but
-- claims made BEFORE it (and any that otherwise slipped through) hold an entity
-- with no lease row. Under the "no lease => stale by definition" rule those
-- read stale in the badge, but the reclaim sweep / stale-alert (which scan
-- claim_leases) stay blind to them. This backfill closes that gap: it inserts an
-- ALREADY-EXPIRED lease (expires_at = epoch) for every currently-claimed,
-- non-terminal entity that lacks one, so the leaseless case is eliminated in the
-- data and legacy claims are stale CONSISTENTLY everywhere. A genuinely-live
-- holder self-heals its lease forward on its next write (assertClaimOk -> renew).
--
-- expires_at is the epoch (always past TTL+grace => stale); claimed_at/heartbeat/
-- last_activity track the entity's updated_at (best available age signal); the
-- row id is a random hex (the meaningful uniqueness is the entity_type+entity_id
-- unique index). Guarded by NOT EXISTS so it is idempotent.

INSERT INTO `claim_leases`
  (`id`, `entity_type`, `entity_id`, `holder_id`, `claimed_at`, `heartbeat_at`,
   `expires_at`, `last_activity_at`, `session_id`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), 'task', t.`id`, t.`assignee_id`,
       t.`updated_at`, t.`updated_at`, '1970-01-01T00:00:00.000Z', t.`updated_at`,
       NULL, '2026-06-15T05:38:23.913Z', '2026-06-15T05:38:23.913Z'
FROM `tasks` t
WHERE t.`assignee_id` IS NOT NULL
  AND t.`status` NOT IN ('done', 'cancelled')
  AND NOT EXISTS (
    SELECT 1 FROM `claim_leases` cl
    WHERE cl.`entity_type` = 'task' AND cl.`entity_id` = t.`id`
  );
--> statement-breakpoint
INSERT INTO `claim_leases`
  (`id`, `entity_type`, `entity_id`, `holder_id`, `claimed_at`, `heartbeat_at`,
   `expires_at`, `last_activity_at`, `session_id`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), 'epic', e.`id`, e.`assignee_id`,
       e.`updated_at`, e.`updated_at`, '1970-01-01T00:00:00.000Z', e.`updated_at`,
       NULL, '2026-06-15T05:38:23.913Z', '2026-06-15T05:38:23.913Z'
FROM `epics` e
WHERE e.`assignee_id` IS NOT NULL
  AND e.`status` NOT IN ('completed', 'cancelled')
  AND NOT EXISTS (
    SELECT 1 FROM `claim_leases` cl
    WHERE cl.`entity_type` = 'epic' AND cl.`entity_id` = e.`id`
  );
--> statement-breakpoint
INSERT INTO `claim_leases`
  (`id`, `entity_type`, `entity_id`, `holder_id`, `claimed_at`, `heartbeat_at`,
   `expires_at`, `last_activity_at`, `session_id`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), 'proposal', p.`id`, p.`claimed_by`,
       p.`updated_at`, p.`updated_at`, '1970-01-01T00:00:00.000Z', p.`updated_at`,
       NULL, '2026-06-15T05:38:23.913Z', '2026-06-15T05:38:23.913Z'
FROM `proposals` p
WHERE p.`claimed_by` IS NOT NULL
  AND p.`status` NOT IN ('completed', 'rejected')
  AND NOT EXISTS (
    SELECT 1 FROM `claim_leases` cl
    WHERE cl.`entity_type` = 'proposal' AND cl.`entity_id` = p.`id`
  );
