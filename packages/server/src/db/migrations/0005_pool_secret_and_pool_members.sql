ALTER TABLE `workspaces` ADD `pool_secret_hash` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `pool_member` integer DEFAULT false NOT NULL;
