CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`anchor_type` text,
	`anchor_id` text,
	`code_locator` text,
	`severity` text,
	`author_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_notes_project_status` ON `notes` (`project_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_notes_anchor` ON `notes` (`anchor_type`,`anchor_id`);
--> statement-breakpoint
CREATE INDEX `idx_notes_project_kind_status` ON `notes` (`project_id`,`kind`,`status`);
