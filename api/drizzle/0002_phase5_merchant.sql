CREATE TABLE `merchant_accounts` (
	`merchant_id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_accounts_application_id_unique` ON `merchant_accounts` (`application_id`);--> statement-breakpoint
ALTER TABLE `review_tasks` ADD `resolution_note` text;--> statement-breakpoint
CREATE UNIQUE INDEX `applications_merchant_id_uq` ON `applications` (`merchant_id`);