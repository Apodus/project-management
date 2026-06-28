CREATE TABLE `triage_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`note_id` text NOT NULL,
	`mode` text NOT NULL,
	`decision` text NOT NULL,
	`rationale` text,
	`confidence` real,
	`resulting_proposal_id` text,
	`resulting_task_id` text,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resulting_proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resulting_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_triage_decisions_project_created` ON `triage_decisions` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_triage_decisions_note` ON `triage_decisions` (`note_id`);