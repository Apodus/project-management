CREATE TABLE `integrator_health` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`resource` text DEFAULT 'main' NOT NULL,
	`integrator_id` text,
	`status` text NOT NULL,
	`pool_size` integer,
	`pool_leased` integer,
	`in_flight_requests` integer DEFAULT 0 NOT NULL,
	`in_flight_batches` integer DEFAULT 0 NOT NULL,
	`in_flight_groups` integer DEFAULT 0 NOT NULL,
	`version` text,
	`last_seen_at` text NOT NULL,
	`unhealthy_notified` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`integrator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_integrator_health_project_resource` ON `integrator_health` (`project_id`,`resource`);