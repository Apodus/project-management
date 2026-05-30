CREATE TABLE `merge_request_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`resource` text DEFAULT 'main' NOT NULL,
	`state` text DEFAULT 'forming' NOT NULL,
	`submitted_by` text NOT NULL,
	`integrator_id` text,
	`resolved_at` text,
	`resolution_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`integrator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_merge_request_groups_project_state` ON `merge_request_groups` (`project_id`,`state`);
--> statement-breakpoint
CREATE INDEX `idx_merge_request_groups_resource_state` ON `merge_request_groups` (`project_id`,`resource`,`state`,`created_at`);
--> statement-breakpoint
CREATE TABLE `merge_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`group_id` text,
	`type` text NOT NULL,
	`inner_repo` text NOT NULL,
	`orphaned_sha` text NOT NULL,
	`outer_repo` text NOT NULL,
	`inner_request_id` text,
	`task_id` text,
	`state` text DEFAULT 'open' NOT NULL,
	`opened_at` text NOT NULL,
	`resolved_at` text,
	`resolution` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `merge_request_groups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`inner_request_id`) REFERENCES `merge_requests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_merge_incidents_project_state` ON `merge_incidents` (`project_id`,`state`);
--> statement-breakpoint
CREATE INDEX `idx_merge_incidents_group` ON `merge_incidents` (`group_id`);
--> statement-breakpoint
CREATE INDEX `idx_merge_incidents_open` ON `merge_incidents` (`project_id`,`state`,`type`,`opened_at`);
--> statement-breakpoint
ALTER TABLE `merge_requests` ADD COLUMN `group_id` text REFERENCES merge_request_groups(id) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `idx_merge_requests_group` ON `merge_requests` (`group_id`);