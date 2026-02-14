export { spawnKernel } from "./kernel.js";
export type { KernelEvent, KernelResult } from "./kernel.js";
export { kernelOptions } from "./options.js";
export type { KernelConfig } from "./options.js";
export { createDB } from "./db.js";
export type { MatrixDB } from "./db.js";
export { ensureHome } from "./boot.js";
export { buildSystemPrompt, estimateTokens } from "./prompt.js";
export { loadSoul, loadIdentity, loadUser, loadBootstrap } from "./soul.js";
export { loadSkills, loadSkillBody, buildSkillsToc } from "./skills.js";
export type { SkillDefinition } from "./skills.js";
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
export { createGitSnapshotHook } from "./hooks.js";
export {
  createProtectedFilesHook,
  createWatchdog,
  PROTECTED_FILE_PATTERNS,
} from "./evolution.js";
export type { WatchdogConfig, Watchdog } from "./evolution.js";
