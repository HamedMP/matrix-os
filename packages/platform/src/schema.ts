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

// OAuth 2.0 Device Authorization Grant (RFC 8628). Codes are short-lived
// (15 min). Approved rows carry the Clerk user ID until polled, then they're
// deleted. Expired rows are GC'd lazily on poll.
export const deviceCodes = sqliteTable(
  'device_codes',
  {
    deviceCode: text('device_code').primaryKey(),
    userCode: text('user_code').notNull().unique(),
    clerkUserId: text('clerk_user_id'),
    expiresAt: integer('expires_at').notNull(),
    lastPolledAt: integer('last_polled_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_device_codes_user_code').on(table.userCode),
    index('idx_device_codes_expires_at').on(table.expiresAt),
  ],
);

export { appsRegistry, appRatings, appInstalls } from './app-registry.js';
export { matrixUsers } from './matrix-provisioning.js';
export { posts, comments, likes, follows } from './social-feed.js';
