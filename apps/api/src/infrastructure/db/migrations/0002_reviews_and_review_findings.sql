CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`pr_node_id` text,
	`created_by` text,
	`diff_length` integer NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`top_k` integer NOT NULL,
	`retrieved_chunk_ids` text NOT NULL,
	`retrieved_chunk_ids_hash` text NOT NULL,
	`status` text NOT NULL,
	`error_status` integer,
	`error_code` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_creation_input_tokens` integer,
	`cache_read_input_tokens` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`pr_node_id`) REFERENCES `pull_requests`(`node_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_reviews_pr_node_id` ON `reviews` (`pr_node_id`);--> statement-breakpoint
CREATE INDEX `idx_reviews_created_at` ON `reviews` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reviews_status_created_at` ON `reviews` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `review_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`location_hint` text,
	`citation` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_review_findings_review_id` ON `review_findings` (`review_id`);--> statement-breakpoint
CREATE INDEX `idx_review_findings_rule_id` ON `review_findings` (`rule_id`);