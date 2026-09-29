// Loopback port ranges for app-runtime tests that spawn real app servers.
//
// Vitest runs test files in parallel workers, so every file owns a disjoint
// slice. All slices sit below the Linux ephemeral range (32768-60999): ports
// in that range are handed out to outbound sockets from any worker, and an
// app server told to listen on one of them exits with EADDRINUSE. They also
// stay clear of the production APP_PORT_RANGE so tests never collide with a
// gateway running on the same machine.
export const TEST_PORT_RANGES = {
  processManager: { min: 30000, max: 31199 },
  processManagerDatabaseUrl: { min: 31200, max: 31210 },
  processManagerStartupTimeout: { min: 31220, max: 31230 },
  processManagerBadCommand: { min: 31240, max: 31250 },
  processManagerStartupFailure: { min: 31260, max: 31270 },
  processManagerConcurrentFailure: { min: 31280, max: 31290 },
  processManagerIdle: { min: 31300, max: 31310 },
  processManagerIdleReset: { min: 31320, max: 31330 },
  processManagerEviction: { min: 31500, max: 31550 },
  phase2: { min: 31600, max: 31700 },
  phase2Idle: { min: 31720, max: 31730 },
  dispatcher: { min: 31800, max: 31900 },
} as const;
