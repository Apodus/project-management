ALTER TABLE `notes` ADD COLUMN `triaged_at` text;
--> statement-breakpoint
ALTER TABLE `notes` ADD COLUMN `triaged_by` text REFERENCES users(id) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `notes` ADD COLUMN `triage_outcome` text;
--> statement-breakpoint
ALTER TABLE `notes` ADD COLUMN `triage_reason` text;
--> statement-breakpoint
ALTER TABLE `notes` ADD COLUMN `promoted_proposal_id` text REFERENCES proposals(id) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `notes` ADD COLUMN `promoted_task_id` text REFERENCES tasks(id) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `proposals` ADD COLUMN `source_note_id` text REFERENCES notes(id) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `source_note_id` text REFERENCES notes(id) ON UPDATE no action ON DELETE set null;