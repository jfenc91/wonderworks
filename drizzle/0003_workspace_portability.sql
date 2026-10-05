CREATE TABLE `wonderworks_schema` (`version` integer PRIMARY KEY NOT NULL);
--> statement-breakpoint
INSERT INTO `wonderworks_schema` (`version`) VALUES (4);
--> statement-breakpoint
CREATE TABLE `workspace_imports` (`key` text PRIMARY KEY NOT NULL, `actor` text NOT NULL, `fingerprint` text NOT NULL, `result` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `workspace_provenance` (`project` text PRIMARY KEY NOT NULL, `data` text NOT NULL);
