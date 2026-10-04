CREATE TABLE `workspace_records` (
	`project` text NOT NULL,
	`hash` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`project`, `hash`),
	CONSTRAINT "workspace_record_size" CHECK(length(CAST("workspace_records"."data" AS BLOB)) <= 65536)
);
--> statement-breakpoint
CREATE TABLE `workspace_storage_versions` (
	`project` text NOT NULL,
	`version` integer NOT NULL,
	`data` text NOT NULL,
	`sha256` text NOT NULL,
	`legacy_data` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`project`, `version`)
);
