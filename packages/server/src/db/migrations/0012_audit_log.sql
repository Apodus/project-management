CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text,
	`metadata_before` text,
	`metadata_after` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audit_log_project_created` ON `audit_log` (`project_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_audit_log_actor` ON `audit_log` (`actor_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_audit_log_target` ON `audit_log` (`target_type`,`target_id`,`created_at`);