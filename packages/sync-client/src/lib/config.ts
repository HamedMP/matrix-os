import { randomBytes } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir, hostname } from "node:os";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "./atomic-write.js";

export const SyncConfigSchema = z.object({
  // platformUrl owns identity: device-flow login, JWT issuance, /api/me.
  // gatewayUrl is the per-user data plane (sync API + WS). They differ in
  // production (both terminate at https://app.matrix-os.com since spec 066
  // PR 1; the platform dispatches HTTP + WS to the right per-user container
  // based on the Clerk session) and may be the same host in single-tenant dev.
  platformUrl: z.url().optional(),
  gatewayUrl: z.url(),
  syncPath: z.string().min(1),
  // gatewayFolder = subtree on the gateway to mirror. Default "" means
  // "the entire user sync root" (Dropbox-style). Set to e.g. "audit" to
  // scope to a single subfolder; the local syncPath then maps 1:1 to
  // `audit/...` on the gateway. See `daemon/remote-prefix.ts` for the
  // mapping logic.
  gatewayFolder: z.string().default(""),
  peerId: z.string().min(1).max(128),
  folders: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  pauseSync: z.boolean().default(false),
});

export type SyncConfig = z.infer<typeof SyncConfigSchema>;

const MAX_GATEWAY_FOLDER_LENGTH = 1024;
const DOUBLE_DOT_SEGMENT = /(?:^|\/)\.\.(?:\/|$)/;

// Single rollout domain: all platform + gateway traffic terminates at
// app.matrix-os.com. The legacy platform.matrix-os.com host was retired in
// spec 066 PR 1 -- do not reintroduce it without updating the platform's
// session-routing middleware at the same time.
export const DEFAULT_PLATFORM_URL = "https://app.matrix-os.com";
export const DEFAULT_GATEWAY_URL = "https://app.matrix-os.com";

export function defaultPlatformUrl(): string {
  return process.env.MATRIXOS_PLATFORM_URL ?? DEFAULT_PLATFORM_URL;
}

export function defaultGatewayUrl(): string {
  return process.env.MATRIXOS_GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
}

function configDir(): string {
  return join(homedir(), ".matrixos");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

export function getConfigDir(): string {
  return configDir();
}

export async function loadConfig(path?: string): Promise<SyncConfig | null> {
  const filePath = path ?? configPath();
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return SyncConfigSchema.parse(parsed);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

export async function saveConfig(
  config: SyncConfig,
  path?: string,
): Promise<void> {
  const filePath = path ?? configPath();
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeUtf8FileAtomic(filePath, JSON.stringify(config, null, 2), 0o600);
}

export function defaultSyncPath(): string {
  return join(homedir(), "matrixos");
}

export function resolveSyncPathWithinHome(
  rawPath: string,
  homeDir: string = homedir(),
): string {
  if (!rawPath.trim()) {
    throw new Error("syncPath is required");
  }

  const homeRoot = resolve(homeDir);
  const candidate = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(homeRoot, rawPath);
  const homePrefix = homeRoot.endsWith(sep) ? homeRoot : `${homeRoot}${sep}`;
  if (candidate !== homeRoot && !candidate.startsWith(homePrefix)) {
    throw new Error("syncPath must stay within your home directory");
  }
  return candidate;
}

function normalizeFolderPath(folder: string): string {
  return folder
    .replace(/\/+/g, "/")
    .split("/")
    .filter((segment) => segment !== ".")
    .join("/")
    .replace(/^\/+|\/+$/g, "");
}

export function normalizeGatewayFolder(folder: string): string {
  const trimmed = folder.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (trimmed.length > MAX_GATEWAY_FOLDER_LENGTH) {
    throw new Error(
      `gatewayFolder exceeds maximum length of ${MAX_GATEWAY_FOLDER_LENGTH} characters`,
    );
  }
  if (trimmed.startsWith("/")) {
    throw new Error("gatewayFolder must not start with /");
  }
  if (trimmed.includes("\\")) {
    throw new Error("gatewayFolder must not contain backslashes");
  }
  if (trimmed.includes("\0")) {
    throw new Error("gatewayFolder must not contain null bytes");
  }

  const normalized = normalizeFolderPath(trimmed);
  if (
    normalized === ".." ||
    DOUBLE_DOT_SEGMENT.test(normalized)
  ) {
    throw new Error("gatewayFolder must not contain '..' segments");
  }
  return normalized;
}

export function generatePeerId(): string {
  const host = hostname().toLowerCase().replace(/\.local$/, "");
  return `${host}-${randomBytes(4).toString("hex")}`;
}
