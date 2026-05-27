CREATE TABLE `agent_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`claimed_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`heartbeat_at` text NOT NULL,
	`pool_secret_hash` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `epics` ADD `assignee_id` text REFERENCES `users`(`id`);
