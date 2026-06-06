CREATE TABLE `claim_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`holder_id` text,
	`claimed_at` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`session_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`holder_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_claim_leases_entity` ON `claim_leases` (`entity_type`,`entity_id`);
--> statement-breakpoint
CREATE INDEX `idx_claim_leases_type_expires` ON `claim_leases` (`entity_type`,`expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_claim_leases_holder` ON `claim_leases` (`holder_id`);
