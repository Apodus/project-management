CREATE TABLE `merge_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`resource` text DEFAULT 'main' NOT NULL,
	`origin_request_id` text,
	`resolved_request_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`conflicting_files` text,
	`attempt_started_at` text,
	`attempt_ended_at` text,
	`escalation_target` text,
	`detail` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`origin_request_id`) REFERENCES `merge_requests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_request_id`) REFERENCES `merge_requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_merge_resolutions_project_state` ON `merge_resolutions` (`project_id`,`state`);
--> statement-breakpoint
CREATE INDEX `idx_merge_resolutions_resource_state` ON `merge_resolutions` (`project_id`,`resource`,`state`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_merge_resolutions_origin` ON `merge_resolutions` (`origin_request_id`);
--> statement-breakpoint
ALTER TABLE `merge_requests` ADD COLUMN `resolved_from` text REFERENCES merge_requests(id) ON UPDATE no action ON DELETE set null;
