ALTER TABLE `merge_locks` ADD `task_id` text REFERENCES `tasks`(`id`);
--> statement-breakpoint
ALTER TABLE `merge_locks` ADD `branch` text;
--> statement-breakpoint
ALTER TABLE `merge_locks` ADD `commit_sha` text;
--> statement-breakpoint
ALTER TABLE `merge_locks` ADD `verify_cmd` text;
--> statement-breakpoint
ALTER TABLE `merge_locks` ADD `worktree_path` text;
--> statement-breakpoint
ALTER TABLE `merge_locks` ADD `abandon_reason` text;
--> statement-breakpoint
ALTER TABLE `merge_lock_queue` ADD `task_id` text REFERENCES `tasks`(`id`);
--> statement-breakpoint
ALTER TABLE `merge_lock_queue` ADD `branch` text;
--> statement-breakpoint
ALTER TABLE `merge_lock_queue` ADD `commit_sha` text;
--> statement-breakpoint
ALTER TABLE `merge_lock_queue` ADD `verify_cmd` text;
--> statement-breakpoint
ALTER TABLE `merge_lock_queue` ADD `worktree_path` text;
