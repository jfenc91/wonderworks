CREATE TABLE `workspace_deletions` (`project` text PRIMARY KEY NOT NULL, `actor` text NOT NULL, `key` text NOT NULL, `fingerprint` text NOT NULL, `version` integer NOT NULL, `deleted_at` text NOT NULL, `expires_at` integer NOT NULL);
--> statement-breakpoint
INSERT INTO `wonderworks_schema` (`version`) VALUES (5);
