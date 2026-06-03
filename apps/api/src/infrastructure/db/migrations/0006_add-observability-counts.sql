ALTER TABLE `reviews` ADD `hallucinated_finding_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reviews` ADD `cache_hit_count` integer DEFAULT 0 NOT NULL;