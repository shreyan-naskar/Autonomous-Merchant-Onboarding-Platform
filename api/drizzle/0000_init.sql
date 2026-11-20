CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`merchant_name` text NOT NULL,
	`pan` text,
	`gst` text,
	`bank_account` text,
	`ifsc` text,
	`bank_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`state_entered_at` integer NOT NULL,
	`merchant_id` text
);
--> statement-breakpoint
CREATE INDEX `applications_status_idx` ON `applications` (`status`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` text NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`from_state` text,
	`to_state` text,
	`event` text NOT NULL,
	`detail` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_app_idx` ON `audit_log` (`application_id`,`id`);--> statement-breakpoint
CREATE TABLE `callback_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`application_id` text,
	`kind` text,
	`payload` text NOT NULL,
	`received_at` integer NOT NULL,
	`processed` integer DEFAULT false NOT NULL,
	`is_duplicate` integer DEFAULT false NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `callback_events_event_id_uq` ON `callback_events` (`event_id`) WHERE "callback_events"."is_duplicate" = 0;--> statement-breakpoint
CREATE INDEX `callback_events_app_idx` ON `callback_events` (`application_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` text NOT NULL,
	`type` text NOT NULL,
	`path` text,
	`payload` text,
	`blur_score` real,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `documents_app_idx` ON `documents` (`application_id`);--> statement-breakpoint
CREATE TABLE `extracted_fields` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` text NOT NULL,
	`document_id` integer,
	`field` text NOT NULL,
	`value` text,
	`confidence` real NOT NULL,
	`validation_status` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `extracted_fields_app_idx` ON `extracted_fields` (`application_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`run_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_due_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `review_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`resolution` text,
	`note` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_tasks_status_idx` ON `review_tasks` (`status`,`application_id`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`application_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`request_id` text,
	`attempt` integer DEFAULT 1 NOT NULL,
	`bank_version` integer NOT NULL,
	`superseded` integer DEFAULT false NOT NULL,
	`score` integer,
	`requested_at` integer NOT NULL,
	`completed_at` integer,
	`raw_response` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `verifications_app_kind_idx` ON `verifications` (`application_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `verifications_request_id_uq` ON `verifications` (`request_id`);