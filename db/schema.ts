import { sqliteTable, text, integer, index, primaryKey, check } from 'drizzle-orm/sqlite-core';
import {sql} from 'drizzle-orm';
export const workspaces=sqliteTable('workspaces',{id:text('id').primaryKey(),data:text('data').notNull(),version:integer('version').notNull().default(0)});
export const wonderworksSchema=sqliteTable('wonderworks_schema',{version:integer('version').primaryKey()});
export const workspaceImports=sqliteTable('workspace_imports',{key:text('key').primaryKey(),actor:text('actor').notNull(),fingerprint:text('fingerprint').notNull(),result:text('result').notNull(),createdAt:text('created_at').notNull()});
export const workspaceProvenance=sqliteTable('workspace_provenance',{project:text('project').primaryKey(),data:text('data').notNull()});
export const workspaceDeletions=sqliteTable('workspace_deletions',{project:text('project').primaryKey(),actor:text('actor').notNull(),key:text('key').notNull(),fingerprint:text('fingerprint').notNull(),version:integer('version').notNull(),deletedAt:text('deleted_at').notNull(),expiresAt:integer('expires_at').notNull()});
export const mcpReceipts=sqliteTable('mcp_receipts',{
  key:text('key').primaryKey(),project:text('project').notNull(),fingerprint:text('fingerprint').notNull(),
  result:text('result').notNull(),expiresAt:integer('expires_at').notNull()
},table=>[index('mcp_receipts_expiry').on(table.expiresAt)]);
// Immutable, project-scoped records. The workspace row holds only a small root
// pointer. Frozen revisions share identical records without sharing JS objects.
export const workspaceRecords=sqliteTable('workspace_records',{
  project:text('project').notNull(),hash:text('hash').notNull(),data:text('data').notNull()
},t=>[primaryKey({columns:[t.project,t.hash]}),check('workspace_record_size',sql`length(CAST(${t.data} AS BLOB)) <= 65536`)]);
export const workspaceStorageVersions=sqliteTable('workspace_storage_versions',{
  project:text('project').notNull(),version:integer('version').notNull(),
  data:text('data').notNull(),sha256:text('sha256').notNull(),
  legacyData:text('legacy_data'),createdAt:text('created_at').notNull()
},t=>[primaryKey({columns:[t.project,t.version]})]);
