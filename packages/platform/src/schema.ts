import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const containers = sqliteTable(
  'containers',
  {
    handle: text('handle').primaryKey(),
    clerkUserId: text('clerk_user_id').notNull().unique(),
    containerId: text('container_id'),
    port: integer('port').notNull(),
    shellPort: integer('shell_port').notNull(),
    status: text('status').default('provisioning').notNull(),
    createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
    lastActive: text('last_active').notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_containers_status').on(table.status),
    index('idx_containers_clerk').on(table.clerkUserId),
  ],
);

export const portAssignments = sqliteTable('port_assignments', {
  port: integer('port').primaryKey(),
  handle: text('handle'),
});
