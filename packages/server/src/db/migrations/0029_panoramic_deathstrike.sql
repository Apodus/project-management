CREATE TABLE `escalation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`escalation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`message_type` text,
	`metadata` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`escalation_id`) REFERENCES `escalations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_escalation_messages_thread_seq` ON `escalation_messages` (`escalation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `escalations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`severity` text,
	`title` text NOT NULL,
	`body` text,
	`code_locator` text,
	`anchor_type` text,
	`anchor_id` text,
	`origin_repo` text NOT NULL,
	`origin_worker_key` text NOT NULL,
	`holder_id` text,
	`author_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`holder_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_escalations_project_status` ON `escalations` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_escalations_holder` ON `escalations` (`holder_id`);--> statement-breakpoint
CREATE INDEX `idx_escalations_origin` ON `escalations` (`origin_repo`,`origin_worker_key`);