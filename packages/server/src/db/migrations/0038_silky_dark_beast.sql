CREATE TABLE `merge_phase_timings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`resource` text DEFAULT 'main' NOT NULL,
	`request_id` text,
	`group_id` text,
	`attempt_id` text,
	`phase` text NOT NULL,
	`label` text,
	`started_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`detail` text,
	`recorded_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request_id`) REFERENCES `merge_requests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`group_id`) REFERENCES `merge_request_groups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`attempt_id`) REFERENCES `merge_attempts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_merge_phase_timings_lane` ON `merge_phase_timings` (`project_id`,`resource`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_merge_phase_timings_request` ON `merge_phase_timings` (`request_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_merge_phase_timings_group` ON `merge_phase_timings` (`group_id`,`started_at`);