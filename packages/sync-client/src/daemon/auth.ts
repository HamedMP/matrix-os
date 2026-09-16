import { join } from 'node:path';
import type { AuthData } from '../auth/token-store.js';
import { clearAuth, clearProfileAuth, loadAuth, loadProfileAuth } from '../auth/token-store.js';
import { loadProfiles } from '../lib/profiles.js';
import { getConfigDir } from '../lib/config.js';
import type { SyncConfig } from '../lib/config.js';

const configDir = getConfigDir();
/**
 * Sync daemon Daemon auth resolution.
 *
 * Extracted from ./index.ts (Phase 1-A4). Pure move: no logic changes.
 */

export interface DaemonAuthResolution {
  auth: AuthData | null;
  profileName: string;
  source: "profile" | "legacy" | "none";
}

export interface DaemonAuthFileAccessors {
  loadAuth: () => Promise<AuthData | null>;
  clearAuth: () => Promise<void>;
}

export function createDaemonAuthFileAccessors(
  resolution: Pick<DaemonAuthResolution, "profileName" | "source">,
  authConfigDir = configDir,
): DaemonAuthFileAccessors {
  if (resolution.source === "legacy") {
    const legacyAuthPath = join(authConfigDir, "auth.json");
    return {
      loadAuth: () => loadAuth(legacyAuthPath),
      clearAuth: () => clearAuth(legacyAuthPath),
    };
  }

  return {
    loadAuth: () => loadProfileAuth(resolution.profileName, authConfigDir),
    clearAuth: () => clearProfileAuth(resolution.profileName, authConfigDir),
  };
}

export async function resolveDaemonAuth(
  config: Pick<SyncConfig, "profile">,
  authConfigDir = configDir,
): Promise<DaemonAuthResolution> {
  let profileName = config.profile;
  if (!profileName) {
    const profiles = await loadProfiles({
      configDir: authConfigDir,
      migrateLegacyFiles: false,
    });
    profileName = profiles.active;
  }
  const profileAuth = await loadProfileAuth(profileName, authConfigDir);
  if (profileAuth) {
    return { auth: profileAuth, profileName, source: "profile" };
  }

  const legacyAuth = await loadAuth(join(authConfigDir, "auth.json"));
  if (legacyAuth) {
    return { auth: legacyAuth, profileName, source: "legacy" };
  }

  return { auth: null, profileName, source: "none" };
}
