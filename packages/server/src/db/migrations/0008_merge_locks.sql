CREATE TABLE `merge_locks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`resource` text NOT NULL,
	`holder_id` text,
	`acquired_at` text,
	`heartbeat_at` text,
	`expires_at` text,
	`landed_sha` text,
	`landed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`holder_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_merge_locks_project_resource` ON `merge_locks` (`project_id`,`resource`);
--> statement-breakpoint
CREATE INDEX `idx_merge_locks_holder` ON `merge_locks` (`holder_id`);
--> statement-breakpoint
CREATE TABLE `merge_lock_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`lock_id` text NOT NULL,
	`user_id` text NOT NULL,
	`enqueued_at` text NOT NULL,
	`notified_at` text,
	FOREIGN KEY (`lock_id`) REFERENCES `merge_locks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_queue_lock_enqueued` ON `merge_lock_queue` (`lock_id`,`enqueued_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_queue_lock_user` ON `merge_lock_queue` (`lock_id`,`user_id`);
