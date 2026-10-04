CREATE TABLE `mcp_receipts` (
	`key` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`fingerprint` text NOT NULL,
	`result` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mcp_receipts_expiry` ON `mcp_receipts` (`expires_at`);