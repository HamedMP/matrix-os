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

export const userMachines = sqliteTable(
  'user_machines',
  {
    machineId: text('machine_id').primaryKey(),
    clerkUserId: text('clerk_user_id').notNull().unique(),
    handle: text('handle').notNull(),
    hetznerServerId: integer('hetzner_server_id'),
    publicIPv4: text('public_ipv4'),
    publicIPv6: text('public_ipv6'),
    status: text('status').notNull().default('provisioning'),
    imageVersion: text('image_version'),
    registrationTokenHash: text('registration_token_hash'),
    registrationTokenExpiresAt: text('registration_token_expires_at'),
    provisionedAt: text('provisioned_at').notNull().$defaultFn(() => new Date().toISOString()),
    lastSeenAt: text('last_seen_at'),
    deletedAt: text('deleted_at'),
    failureCode: text('failure_code'),
    failureAt: text('failure_at'),
  },
  (table) => [
    index('idx_user_machines_status').on(table.status),
    index('idx_user_machines_clerk').on(table.clerkUserId),
    index('idx_user_machines_hetzner').on(table.hetznerServerId),
  ],
);

export const portAssignments = sqliteTable('port_assignments', {
  port: integer('port').primaryKey(),
  handle: text('handle'),
});

// OAuth 2.0 Device Authorization Grant (RFC 8628). Codes are short-lived
// (15 min). Approval stores the Clerk user ID. The first approved poll claims
// and deletes the row before token issuance so timeouts/crashes cannot issue a
// second token for the same device code. Expired rows are GC'd lazily on poll.
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
