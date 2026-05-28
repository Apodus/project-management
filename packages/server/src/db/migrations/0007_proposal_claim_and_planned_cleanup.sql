ALTER TABLE `proposals` ADD `claimed_by` text REFERENCES `users`(`id`);
--> statement-breakpoint
CREATE INDEX `idx_proposals_claimed_by` ON `proposals` (`claimed_by`);
--> statement-breakpoint
UPDATE `proposals` SET `status` = 'in_progress' WHERE `status` = 'planned';
