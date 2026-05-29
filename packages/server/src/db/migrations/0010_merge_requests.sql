CREATE TABLE `merge_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`resource` text DEFAULT 'main' NOT NULL,
	`submitted_by` text NOT NULL,
	`task_id` text,
	`branch` text,
	`commit_sha` text,
	`verify_cmd` text,
	`worktree_path` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`enqueued_at` text NOT NULL,
	`picked_up_at` text,
	`resolved_at` text,
	`landed_sha` text,
	`reject_category` text,
	`reject_reason` text,
	`failed_files` text,
	`log_excerpt` text,
	`log_url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_merge_requests_project_status` ON `merge_requests` (`project_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_merge_requests_resource_status` ON `merge_requests` (`project_id`,`resource`,`status`,`enqueued_at`);
--> statement-breakpoint
CREATE INDEX `idx_merge_requests_task` ON `merge_requests` (`task_id`);
--> statement-breakpoint
CREATE TABLE `merge_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`base_sha` text NOT NULL,
	`tree_sha` text,
	`status` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`verify_duration_ms` integer,
	`failure_category` text,
	`failure_reason` text,
	`failed_files` text,
	`log_excerpt` text,
	`log_url` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `merge_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_merge_attempts_request_num` ON `merge_attempts` (`request_id`,`attempt_number`);
