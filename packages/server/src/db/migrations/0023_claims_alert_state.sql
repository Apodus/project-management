CREATE TABLE `claims_alert_state` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`stale_claims_notified` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_claims_alert_state_project` ON `claims_alert_state` (`project_id`);
