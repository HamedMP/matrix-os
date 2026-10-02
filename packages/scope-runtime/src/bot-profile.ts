/**
 * `scope-runtime-bot-v1`: the isolated workload profile for Matrix bots.
 *
 * It keeps every isolation property of `scope-runtime-chat-v1` (dynamic
 * user, private network and root, no capabilities, the same resource caps)
 * and differs in two places only: a lifetime that fits a bot task's active
 * work deadline, and the pinned bot-runtime bundle mounted in place of the
 * Claude SDK, native binary, and Chat worker file. The chat profile and its
 * digest are unchanged.
 */
import { createHash } from "node:crypto";
import {
  BROKER_SOCKET_TOKEN,
  COMMAND_DIRECTORY_TOKEN,
  FIXED_SYSTEMD_ENVIRONMENT,
  FIXED_SYSTEMD_PROPERTIES,
  NATIVE_DIRECTORY_TOKEN,
  READINESS_FILE_TOKEN,
  SCOPE_ROOT_TOKEN,
  SDK_DIRECTORY_TOKEN,
  WORKER_FILE_TOKEN,
} from "./profile.js";

export const SCOPE_RUNTIME_BOT_PROFILE_ID = "scope-runtime-bot-v1";
export const SCOPE_RUNTIME_BOT_PROFILE_VERSION = 1;
export const SCOPE_RUNTIME_BOT_ADAPTER_ID = "matrix-bot";
/** The pinned Pi agent version inside the bot-runtime bundle. */
export const SCOPE_RUNTIME_BOT_HARNESS_VERSION = "0.86.1";
export const SCOPE_RUNTIME_BOT_RUNTIME_MAX_SEC = 900;
/** Where the bot-runtime bundle directory is mounted, and its entry file inside the sandbox. */
export const BOT_RUNTIME_MOUNT = "/opt/matrix/scope-sdk/bot-runtime";
export const BOT_RUNTIME_ENTRY = `${BOT_RUNTIME_MOUNT}/bot-worker.mjs`;
export const BOT_RUNTIME_DIRECTORY_TOKEN = "<bot-runtime-directory>";

const CHAT_ONLY_MOUNTS: readonly string[] = [
  `BindReadOnlyPaths=${SDK_DIRECTORY_TOKEN}:/opt/matrix/scope-sdk/sdk`,
  `BindReadOnlyPaths=${NATIVE_DIRECTORY_TOKEN}:/opt/matrix/scope-sdk/native`,
  `BindReadOnlyPaths=${WORKER_FILE_TOKEN}:/opt/matrix/scope-runtime/worker.mjs`,
];

function deriveBotProperties(): readonly string[] {
  const properties: string[] = [];
  for (const property of FIXED_SYSTEMD_PROPERTIES) {
    if (property === CHAT_ONLY_MOUNTS[0]) {
      properties.push(`BindReadOnlyPaths=${BOT_RUNTIME_DIRECTORY_TOKEN}:${BOT_RUNTIME_MOUNT}`);
      continue;
    }
    if (CHAT_ONLY_MOUNTS.includes(property)) continue;
    properties.push(property === "RuntimeMaxSec=90" ? `RuntimeMaxSec=${SCOPE_RUNTIME_BOT_RUNTIME_MAX_SEC}` : property);
  }
  return Object.freeze(properties);
}

export const FIXED_BOT_SYSTEMD_PROPERTIES = deriveBotProperties();

export const SCOPE_RUNTIME_BOT_PROFILE_DIGEST = createHash("sha256")
  .update([
    ...FIXED_BOT_SYSTEMD_PROPERTIES,
    ...FIXED_SYSTEMD_ENVIRONMENT,
    `Adapter=${SCOPE_RUNTIME_BOT_ADAPTER_ID}/${SCOPE_RUNTIME_BOT_HARNESS_VERSION}/bot_agent`,
  ].join("\n") + "\n")
  .digest("hex");

/** Ordinary owner-authorized Chat shares Pi's worker, never recipe Bot mount authority. */
export const SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID = "scope-runtime-managed-pi-v1";
export const SCOPE_RUNTIME_MANAGED_PI_PROFILE_VERSION = 1;
export const SCOPE_RUNTIME_MANAGED_PI_PROFILE_DIGEST = createHash("sha256")
  .update(`${SCOPE_RUNTIME_BOT_PROFILE_DIGEST}\nProfile=${SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID}\nRoots=agent-workspaces,projects,worktrees\n`)
  .digest("hex");

/** Fixed Pi profile identity used by launch and reconciliation; unknown profiles never qualify. */
export function piProfileIdentity(profileId: string | undefined) {
  if (profileId === SCOPE_RUNTIME_BOT_PROFILE_ID) return {
    profileId, profileVersion: SCOPE_RUNTIME_BOT_PROFILE_VERSION, profileDigest: SCOPE_RUNTIME_BOT_PROFILE_DIGEST,
  };
  if (profileId === SCOPE_RUNTIME_MANAGED_PI_PROFILE_ID) return {
    profileId, profileVersion: SCOPE_RUNTIME_MANAGED_PI_PROFILE_VERSION, profileDigest: SCOPE_RUNTIME_MANAGED_PI_PROFILE_DIGEST,
  };
  return undefined;
}

export interface ScopeRuntimeBotProfilePaths {
  scopeRoot: string;
  botRuntimeDirectory: string;
  brokerSocket: string;
  readinessFile: string;
  commandDirectory: string;
}

export function materializeBotSystemdProperties(paths: ScopeRuntimeBotProfilePaths): string[] {
  const replacements: Readonly<Record<string, string>> = {
    [SCOPE_ROOT_TOKEN]: paths.scopeRoot,
    [BOT_RUNTIME_DIRECTORY_TOKEN]: paths.botRuntimeDirectory,
    [BROKER_SOCKET_TOKEN]: paths.brokerSocket,
    [READINESS_FILE_TOKEN]: paths.readinessFile,
    [COMMAND_DIRECTORY_TOKEN]: paths.commandDirectory,
  };
  return FIXED_BOT_SYSTEMD_PROPERTIES.map((property) => {
    let result: string = property;
    for (const [token, value] of Object.entries(replacements)) result = result.replace(token, value);
    return result;
  });
}

export function isBotAdapter(adapterId: string, harnessVersion: string): boolean {
  return adapterId === SCOPE_RUNTIME_BOT_ADAPTER_ID && harnessVersion === SCOPE_RUNTIME_BOT_HARNESS_VERSION;
}
