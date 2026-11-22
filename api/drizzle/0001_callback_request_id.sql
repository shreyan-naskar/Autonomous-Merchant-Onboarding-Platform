ALTER TABLE `callback_events` ADD `request_id` text;--> statement-breakpoint
CREATE INDEX `callback_events_request_idx` ON `callback_events` (`request_id`);