ALTER TABLE `reviews` ADD `turn_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reviews` ADD `tool_calls_json` text;--> statement-breakpoint
-- Backfill historical rows that made exactly one Anthropic call.
-- Pre-turn-1 failures (errors before the first messages.create response
-- returns) stay at the default 0 so eval can distinguish "no turn started"
-- from "single-turn historical" from multi-turn rows without joining on
-- prompt_version.
--
-- The `prompt_version = 'v2'` filter scopes the backfill to single-version
-- rows (v2 was used previously; v3+ is current). Without this filter,
-- re-applying the migration after a backup restore — or a hotfix
-- revert/re-apply cycle that drops `__drizzle_migrations` — would
-- silently relabel any `internal_error` row (which omits turn_count and
-- stays at 0) as if it were a historical single-call row.
UPDATE `reviews` SET `turn_count` = 1 WHERE `status` IN ('completed', 'failed') AND `turn_count` = 0 AND `prompt_version` = 'v2';