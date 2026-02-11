export { spawnKernel } from "./kernel.js";
export type { KernelEvent, KernelResult } from "./kernel.js";
export { kernelOptions } from "./options.js";
export type { KernelConfig } from "./options.js";
export { createDB } from "./db.js";
export type { MatrixDB } from "./db.js";
export { ensureHome } from "./boot.js";
export { buildSystemPrompt } from "./prompt.js";
export {
  loadHealthCheckTargets,
  checkModuleHealth,
  backupModule,
  restoreModule,
  createHeartbeat,
} from "./heartbeat.js";
export type {
  HealthTarget,
  HealthCheckResult,
  ModuleHealth,
  HeartbeatConfig,
  Heartbeat,
} from "./heartbeat.js";
