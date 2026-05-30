CREATE TABLE `verify_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`resource` text DEFAULT 'main' NOT NULL,
	`tree_sha` text NOT NULL,
	`step_id` text NOT NULL,
	`step_config_sha` text NOT NULL,
	`result` text NOT NULL,
	`duration_ms` integer,
	`log_excerpt` text,
	`log_url` text,
	`created_at` text NOT NULL,
	`last_hit_at` text,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_verify_cache_key` ON `verify_cache` (`project_id`,`resource`,`tree_sha`,`step_id`,`step_config_sha`);
--> statement-breakpoint
CREATE INDEX `idx_verify_cache_project_resource_created` ON `verify_cache` (`project_id`,`resource`,`created_at`);