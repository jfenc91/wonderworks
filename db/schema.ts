import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const workspaces=sqliteTable('workspaces',{id:text('id').primaryKey(),data:text('data').notNull(),version:integer('version').notNull().default(0)});
export const mcpReceipts=sqliteTable('mcp_receipts',{
  key:text('key').primaryKey(),project:text('project').notNull(),fingerprint:text('fingerprint').notNull(),
  result:text('result').notNull(),expiresAt:integer('expires_at').notNull()
},table=>[index('mcp_receipts_expiry').on(table.expiresAt)]);
