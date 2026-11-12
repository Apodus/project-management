CREATE TABLE `agent_conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`direction` text NOT NULL,
	`kind` text DEFAULT 'update' NOT NULL,
	`body` text NOT NULL,
	`author_label` text NOT NULL,
	`reply_to_id` text,
	`discord_message_id` text,
	`created_at` text NOT NULL,
	`provider_created_at` text,
	`acknowledged_at` text,
	`acknowledged_generation` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `agent_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_message_sequence` ON `agent_conversation_messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_agent_message_unread` ON `agent_conversation_messages` (`conversation_id`,`direction`,`acknowledged_at`);--> statement-breakpoint
CREATE TABLE `agent_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`project_id` text NOT NULL,
	`route_generation` integer NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`recipient_discord_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`consumer_generation` integer DEFAULT 1 NOT NULL,
	`session_title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`is_test` integer DEFAULT false NOT NULL,
	`last_checked_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_conversations_code_unique` ON `agent_conversations` (`code`);--> statement-breakpoint
CREATE INDEX `idx_agent_conversation_owner_session` ON `agent_conversations` (`owner_user_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `discord_agent_routes` (
	`project_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`channel_name` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`recipient_discord_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`generation` integer NOT NULL,
	`activated_at` text NOT NULL,
	`verified_at` text NOT NULL,
	`test_until` text,
	`error_code` text,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `discord_bridge_lease` (
	`id` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`fence` integer NOT NULL,
	`lease_until` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `discord_channel_state` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`watermark` text NOT NULL,
	`scan_upper` text,
	`scan_before` text,
	`last_synced_at` text,
	`error_code` text,
	`cooldown_until` text,
	`last_hint_at` text
);
--> statement-breakpoint
CREATE TABLE `discord_delivery_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`operation` text NOT NULL,
	`operation_key` text NOT NULL,
	`idempotency_key` text,
	`request_hash` text,
	`content` text NOT NULL,
	`reference` text NOT NULL,
	`nonce` text NOT NULL,
	`route_generation` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`lease_until` text,
	`fence` integer DEFAULT 0 NOT NULL,
	`discord_message_id` text,
	`delivered_at` text,
	`error_code` text,
	`uncertain` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `agent_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `agent_conversation_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discord_delivery_jobs_operation_key_unique` ON `discord_delivery_jobs` (`operation_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `discord_delivery_jobs_reference_unique` ON `discord_delivery_jobs` (`reference`);--> statement-breakpoint
CREATE UNIQUE INDEX `discord_delivery_jobs_nonce_unique` ON `discord_delivery_jobs` (`nonce`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_discord_send_idempotency` ON `discord_delivery_jobs` (`project_id`,`owner_user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_discord_job_due` ON `discord_delivery_jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `discord_inbound_events` (
	`discord_message_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`author_id` text NOT NULL,
	`reference_id` text,
	`body` text NOT NULL,
	`has_attachments` integer NOT NULL,
	`provider_created_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_code` text,
	`message_id` text,
	FOREIGN KEY (`message_id`) REFERENCES `agent_conversation_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_discord_inbound_pending` ON `discord_inbound_events` (`channel_id`,`status`);--> statement-breakpoint
CREATE TABLE `discord_message_links` (
	`channel_id` text NOT NULL,
	`discord_message_id` text NOT NULL,
	`message_id` text NOT NULL,
	`job_id` text,
	PRIMARY KEY(`channel_id`, `discord_message_id`),
	FOREIGN KEY (`message_id`) REFERENCES `agent_conversation_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `discord_delivery_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
