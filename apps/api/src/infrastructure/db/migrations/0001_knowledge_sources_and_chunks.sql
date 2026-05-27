CREATE TABLE `knowledge_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`severity` text,
	`language` text,
	`category` text,
	`embedding_model` text NOT NULL,
	`embedding_dim` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `knowledge_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_knowledge_chunks_source_id` ON `knowledge_chunks` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_chunks_rule_id` ON `knowledge_chunks` (`rule_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_knowledge_chunks_source_rule` ON `knowledge_chunks` (`source_id`,`rule_id`);