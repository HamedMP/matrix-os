/**
 * S07 / T036: sandbox policy for shared runs and shared terminals.
 *
 * The fixed profile (profile.ts) is pinned by its digest and never changes
 * here. The sandbox policy is an additive layer applied on top of it for
 * runs that act for a collaborator: an actor/scope/worktree mount manifest
 * decides what the run can see, the network is denied, credential locations
 * are made inaccessible, and resource caps may only narrow the fixed limits.
 * Nothing in this module reads prompt text or run output.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { SCOPE_RUNTIME_PROFILE_LIMITS, type ScopeRuntimeSandboxManifest } from "./protocol.js";

export const SCOPE_RUNTIME_SANDBOX_POLICY_VERSION = 1;
export const SANDBOX_WORKSPACE_MOUNT = "/workspace/project";
const WORKTREE_TOKEN = "<worktree>";

/** Environment keys that must never reach a sandboxed process. */
export const FORBIDDEN_SANDBOX_ENVIRONMENT = Object.freeze([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GIT_ASKPASS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_SSH_COMMAND",
  "SSH_AUTH_SOCK",
  "SSH_ASKPASS",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "MATRIX_FORGE_TOKEN",
  "MATRIX_UPGRADE_TOKEN",
  "UPGRADE_TOKEN",
  "DATABASE_URL",
  "PIPEDREAM_CLIENT_SECRET",
] as const);

/** Host locations that hold owner credentials; hidden even if a bind mount reaches near them. */
const INACCESSIBLE_PATHS = Object.freeze([
  "-/opt/matrix/env",
  "-/etc/matrix",
  "-/home/matrix/.gitconfig",
  "-/home/matrix/.git-credentials",
  "-/home/matrix/.config/gh",
  "-/home/matrix/.ssh",
  "-/home/matrix/.claude",
  "-/home/matrix/.codex",
  "-/home/matrix/home/.hermes",
  "-/root",
] as const);

const SANDBOX_PROPERTY_TEMPLATE = Object.freeze([
  `BindPaths=${WORKTREE_TOKEN}:${SANDBOX_WORKSPACE_MOUNT}`,
  "PrivateNetwork=yes",
  "IPAddressDeny=any",
  "RestrictAddressFamilies=AF_UNIX",
  "ProtectHome=yes",
  "ProtectSystem=strict",
  "NoNewPrivileges=yes",
  "RestrictSUIDSGID=yes",
  "LockPersonality=yes",
  "MemoryDenyWriteExecute=no",
  ...INACCESSIBLE_PATHS.map((path) => `InaccessiblePaths=${path}`),
  `UnsetEnvironment=${FORBIDDEN_SANDBOX_ENVIRONMENT.join(" ")}`,
] as const);

export const SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST = createHash("sha256")
  .update(`${[
    `SandboxPolicyVersion=${SCOPE_RUNTIME_SANDBOX_POLICY_VERSION}`,
    ...SANDBOX_PROPERTY_TEMPLATE,
    `ForbiddenEnvironment=${FORBIDDEN_SANDBOX_ENVIRONMENT.join(",")}`,
  ].join("\n")}\n`)
  .digest("hex");

export const SCOPE_RUNTIME_SANDBOX_CAPABILITY = Object.freeze({
  policyVersion: SCOPE_RUNTIME_SANDBOX_POLICY_VERSION,
  policyDigest: SCOPE_RUNTIME_SANDBOX_POLICY_DIGEST,
  workloads: ["chat_ai", "terminal"] as ("chat_ai" | "terminal")[],
});

export interface SandboxMountSources {
  /** Canonical (realpath) host directory that is bound at `SANDBOX_WORKSPACE_MOUNT`. */
  worktreeHostPath: string;
}

function assertTrustedHostPath(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || value.includes("\n") || value.includes("\r")
    || value.includes(":") || value.split(sep).includes("..")) {
    throw new Error("Invalid sandbox worktree path");
  }
  return value;
}

/**
 * Materialises the sandbox systemd properties for a validated manifest.
 * Pure: the caller supplies the already validated mount sources. Limits
 * only ever narrow the fixed profile (the schema rejects wider values).
 */
export function buildSandboxSystemdProperties(
  manifest: ScopeRuntimeSandboxManifest,
  sources: SandboxMountSources,
): string[] {
  const worktree = assertTrustedHostPath(sources.worktreeHostPath);
  const properties = SANDBOX_PROPERTY_TEMPLATE.map((property) => property.replace(WORKTREE_TOKEN, worktree));
  if (manifest.worktree.mode === "ro") {
    properties[0] = `BindReadOnlyPaths=${worktree}:${SANDBOX_WORKSPACE_MOUNT}`;
  }
  if (manifest.limits) {
    properties.push(
      `MemoryMax=${manifest.limits.memoryMaxBytes}`,
      `CPUQuota=${manifest.limits.cpuQuotaPercent}%`,
      `TasksMax=${manifest.limits.tasksMax}`,
    );
  }
  return properties;
}

/** Rejects an environment list that would leak a credential or Git configuration into the sandbox. */
export function assertSandboxEnvironment(environment: readonly string[]): void {
  for (const entry of environment) {
    const key = entry.split("=", 1)[0] ?? "";
    if ((FORBIDDEN_SANDBOX_ENVIRONMENT as readonly string[]).includes(key)) {
      throw new Error("Sandbox environment carries a forbidden variable");
    }
  }
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  let current = path;
  while (current !== dirname(current)) {
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error("Sandbox worktree path traverses a symbolic link");
    current = dirname(current);
  }
}

async function assertNotSwappable(worktree: string, allowedRoot: string): Promise<void> {
  let current = dirname(worktree);
  while (current.startsWith(allowedRoot) && current !== dirname(current)) {
    const entry = await lstat(current);
    if ((entry.mode & 0o002) !== 0 && (entry.mode & 0o1000) === 0) {
      throw new Error("Sandbox worktree parent is world-writable");
    }
    if (current === allowedRoot) break;
    current = dirname(current);
  }
}

async function assertNoHardlinkedEntries(worktree: string): Promise<void> {
  // Bounded: only the worktree's own top-level entries are checked. A bind
  // mount cannot follow a hardlink out of the tree, but a hardlinked file
  // shares its inode with a file elsewhere on the host, so the tree must not
  // contain one at the boundary the collaborator can reach first.
  const entries = await readdir(worktree, { withFileTypes: true });
  if (entries.length > 4_096) throw new Error("Sandbox worktree root has too many entries to verify");
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stats = await lstat(resolve(worktree, entry.name));
    if (stats.nlink > 1) throw new Error("Sandbox worktree contains a hardlinked file");
  }
}

/**
 * Validates the manifest's mount sources against the host before launch:
 * absolute, under an allowed root, a real directory reached without symbolic
 * links, not swappable through a world-writable parent, and without hardlinked
 * top-level files. Returns the canonical path to bind.
 */
export async function validateSandboxMountSources(
  manifest: ScopeRuntimeSandboxManifest,
  options: { allowedRoots: readonly string[] },
): Promise<SandboxMountSources> {
  const requested = assertTrustedHostPath(manifest.worktree.hostPath);
  const roots = options.allowedRoots.map((root) => assertTrustedHostPath(root));
  if (roots.length === 0) throw new Error("Sandbox worktree roots are not configured");
  const canonicalRoots = await Promise.all(roots.map((root) => realpath(root)));
  const allowedRoot = canonicalRoots.find((root) => requested === root || requested.startsWith(`${root}${sep}`));
  if (!allowedRoot) throw new Error("Sandbox worktree is outside the allowed roots");
  await assertNoSymlinkComponents(requested);
  const canonical = await realpath(requested);
  if (canonical !== requested) throw new Error("Sandbox worktree path is not canonical");
  const entry = await lstat(canonical);
  if (!entry.isDirectory()) throw new Error("Sandbox worktree is not a directory");
  await assertNotSwappable(canonical, allowedRoot);
  await assertNoHardlinkedEntries(canonical);
  return { worktreeHostPath: canonical };
}

export { SCOPE_RUNTIME_PROFILE_LIMITS };
