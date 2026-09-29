// Loopback port ranges for app-runtime tests that spawn real app servers.
//
// Vitest runs test files in parallel workers, so every file owns a disjoint
// slice. All slices sit below the Linux ephemeral range (32768-60999): ports
// in that range are handed out to outbound sockets from any worker, and an
// app server told to listen on one of them exits with EADDRINUSE. They also
// stay clear of the production APP_PORT_RANGE so tests never collide with a
// gateway running on the same machine.
export const TEST_PORT_RANGES = {
  processManager: { min: 30000, max: 31499 },
  processManagerEviction: { min: 31500, max: 31550 },
  phase2: { min: 31600, max: 31700 },
  phase2Idle: { min: 31720, max: 31730 },
  dispatcher: { min: 31800, max: 31900 },
} as const;
