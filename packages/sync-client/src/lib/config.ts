import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { z } from "zod/v4";

export const SyncConfigSchema = z.object({
  // platformUrl owns identity: device-flow login, JWT issuance, /api/me.
  // gatewayUrl is the per-user data plane (sync API + WS). They differ in
  // production (https://platform.matrix-os.com vs https://alice.matrix-os.com)
  // and may be the same host in single-tenant dev.
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

export function defaultPlatformUrl(): string {
  return process.env.MATRIXOS_PLATFORM_URL ?? "https://platform.matrix-os.com";
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
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function defaultSyncPath(): string {
  return join(homedir(), "matrixos");
}

export function generatePeerId(): string {
  const host = hostname().toLowerCase().replace(/\.local$/, "");
  return host;
}
