CREATE TABLE `automation_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`trigger_event` text NOT NULL,
	`conditions` text,
	`action_type` text NOT NULL,
	`action_config` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_automation_rules_project` ON `automation_rules` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_automation_rules_trigger` ON `automation_rules` (`project_id`,`trigger_event`);