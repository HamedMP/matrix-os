export const MESSAGING_SETUP_SESSION_TTL_MS = 10 * 60 * 1000;
export const MESSAGING_SETUP_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export const MESSAGING_QUEUE_CAPS = {
  eventsPerOwner: 10_000,
  eventsPerNetwork: 2_000,
  eventsPerRoom: 500,
} as const;

export const MESSAGING_MEDIA_CAPS = {
  concurrentJobsPerOwner: 100,
  concurrentJobsPerRoom: 10,
  latestBackfillMessages: 100,
} as const;

export const MESSAGING_HEALTH_TIMEOUT_MS = 10_000;
export const MESSAGING_APP_SERVICE_BODY_LIMIT = 256 * 1024;
export const MESSAGING_ROUTE_BODY_LIMIT = 64 * 1024;
export const MESSAGING_DELETE_BODY_LIMIT = 1024;

export const MESSAGING_IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MESSAGING_HERMES_CAPABILITY_TTL_MS = 60 * 1000;
export const MESSAGING_REVOCATION_ABORT_DEADLINE_MS = 10 * 1000;

export const MESSAGING_BACKUP_RPO_MS = 60 * 60 * 1000;
export const MESSAGING_RESTORE_RTO_MS = 15 * 60 * 1000;
export const WHATSAPP_RELINK_AFTER_STALE_RESTORE_MS = 24 * 60 * 60 * 1000;

export const MESSAGING_RESOURCE_FLOOR = {
  default: {
    vcpu: 2,
    memoryGiB: 4,
    diskGiB: 40,
  },
  synapse: {
    vcpu: 2,
    memoryGiB: 6,
    diskGiB: 60,
  },
} as const;
