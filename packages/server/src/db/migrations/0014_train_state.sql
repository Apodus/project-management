CREATE TABLE `train_state` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`resource` text DEFAULT 'main' NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`changed_by` text,
	`reason` text,
	`changed_at` text,
	`stuck_notified` integer DEFAULT false NOT NULL,
	`abandon_notified` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_train_state_project_resource` ON `train_state` (`project_id`,`resource`);