CREATE TABLE `epic_dependencies` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`epic_id` text NOT NULL,
	`depends_on_epic_id` text NOT NULL,
	`dependency_type` text DEFAULT 'blocks' NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on_epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "epic_deps_no_self" CHECK(`epic_dependencies`.`epic_id` <> `epic_dependencies`.`depends_on_epic_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_epic_deps_epic` ON `epic_dependencies` (`epic_id`);
--> statement-breakpoint
CREATE INDEX `idx_epic_deps_depends_on` ON `epic_dependencies` (`depends_on_epic_id`);
--> statement-breakpoint
CREATE INDEX `idx_epic_deps_project` ON `epic_dependencies` (`project_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_epic_deps_unique` ON `epic_dependencies` (`epic_id`,`depends_on_epic_id`,`dependency_type`);
