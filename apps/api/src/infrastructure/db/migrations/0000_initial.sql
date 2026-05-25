CREATE TABLE `pull_requests` (
	`node_id` text PRIMARY KEY NOT NULL,
	`repo_full_name` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`head_sha` text NOT NULL,
	`base_sha` text NOT NULL,
	`author_login` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`raw_payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pull_requests_repo_number` ON `pull_requests` (`repo_full_name`,`number`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`event_name` text NOT NULL,
	`action` text,
	`pull_request_node_id` text,
	`received_at` integer NOT NULL,
	`raw_payload` text NOT NULL,
	FOREIGN KEY (`pull_request_node_id`) REFERENCES `pull_requests`(`node_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_events_received_at` ON `webhook_events` (`received_at`);