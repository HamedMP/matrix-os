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
export { createTask, claimTask, completeTask, failTask, listTasks, getTask } from "./ipc.js";
export { createGitSnapshotHook, createApprovalHook } from "./hooks.js";
export type { RequestApprovalFn } from "./hooks.js";
export { shouldRequireApproval, DEFAULT_APPROVAL_POLICY } from "./approval.js";
export type { ApprovalPolicy, ToolPattern } from "./approval.js";
export {
  createProtectedFilesHook,
  createWatchdog,
  PROTECTED_FILE_PATTERNS,
} from "./evolution.js";
export type { WatchdogConfig, Watchdog } from "./evolution.js";
export {
  parseSetupPlan,
  writeSetupPlan,
  getPersonaSuggestions,
} from "./onboarding.js";
export type {
  SetupPlan,
  AppSuggestion,
  SkillSuggestion,
  PersonalityConfig,
  PersonaSuggestions,
} from "./onboarding.js";
export { buildSafeModePrompt, safeModeAgentDef } from "./safe-mode.js";
export { loadHandle, saveIdentity, deriveAiHandle } from "./identity.js";
export type { Identity } from "./identity.js";
export { createMemoryStore, extractMemories } from "./memory.js";
export type { MemoryStore, MemoryEntry, MemoryCandidate } from "./memory.js";
export { createImageClient } from "./image-gen.js";
export type { ImageClient, ImageResult } from "./image-gen.js";
export { createUsageTracker } from "./usage.js";
export type { UsageTracker, UsageEntry, UsageSummary } from "./usage.js";
export { loadAppMeta } from "./app-meta.js";
export type { AppMeta } from "./app-meta.js";
