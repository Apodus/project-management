CREATE TABLE `agent_pools` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`created_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_pools_name` ON `agent_pools` (`name`);
--> statement-breakpoint
INSERT INTO `agent_pools` (`id`, `name`, `description`, `created_at`, `updated_at`)
SELECT 'default-pool', 'default', 'Auto-migrated default pool', datetime('now'), datetime('now')
WHERE EXISTS (SELECT 1 FROM `users` WHERE `pool_member` = 1);
--> statement-breakpoint
ALTER TABLE `users` ADD `pool_id` text REFERENCES `agent_pools`(`id`);
--> statement-breakpoint
UPDATE `users` SET `pool_id` = 'default-pool' WHERE `pool_member` = 1;
