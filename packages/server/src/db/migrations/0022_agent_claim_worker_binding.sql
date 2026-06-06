ALTER TABLE `agent_claims` ADD `worker_key` text;
--> statement-breakpoint
ALTER TABLE `agent_claims` ADD `worker_key_pool_id` text;
--> statement-breakpoint
ALTER TABLE `agent_claims` ADD `bind_handle` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_claims_worker` ON `agent_claims` (`worker_key_pool_id`,`worker_key`) WHERE `worker_key` IS NOT NULL;
