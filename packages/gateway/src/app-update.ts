import { existsSync } from 'node:fs';
import { cp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface UpdateResult {
  success: boolean;
  error?: string;
}

export interface RollbackResult {
  success: boolean;
  dataRestored: boolean;
  error?: string;
}

export interface SnapshotResult {
  success: boolean;
  snapshotPath?: string;
  error?: string;
}

export interface RestoreResult {
  success: boolean;
  error?: string;
}

export async function snapshotAppData(options: {
  homePath: string;
  slug: string;
  versionTag: string;
}): Promise<SnapshotResult> {
  const { homePath, slug, versionTag } = options;
  const appDataDir = join(homePath, 'data', slug);

  if (!existsSync(appDataDir)) {
    return { success: false, error: `App data directory not found: ${appDataDir}` };
  }

  const snapshotPath = join(homePath, 'data', '.snapshots', `${slug}-${versionTag}`);
  await mkdir(join(homePath, 'data', '.snapshots'), { recursive: true });
  await cp(appDataDir, snapshotPath, { recursive: true });

  return { success: true, snapshotPath };
}

export async function restoreAppData(options: {
  homePath: string;
  slug: string;
  snapshotPath: string;
}): Promise<RestoreResult> {
  const { homePath, slug, snapshotPath } = options;

  if (!existsSync(snapshotPath)) {
    return { success: false, error: `Data snapshot not found: ${snapshotPath}` };
  }

  const appDataDir = join(homePath, 'data', slug);
  await rm(appDataDir, { recursive: true, force: true });
  await cp(snapshotPath, appDataDir, { recursive: true });

  return { success: true };
}

export async function applyUpdate(options: {
  homePath: string;
  slug: string;
  newVersionBundlePath: string;
}): Promise<UpdateResult> {
  const { homePath, slug, newVersionBundlePath } = options;
  const appDir = join(homePath, 'apps', slug);

  if (!existsSync(appDir)) {
    return { success: false, error: `App "${slug}" not installed at ${appDir}` };
  }

  if (!existsSync(newVersionBundlePath)) {
    return { success: false, error: `New version bundle not found: ${newVersionBundlePath}` };
  }

  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  await cp(newVersionBundlePath, appDir, { recursive: true });

  return { success: true };
}

export async function rollbackUpdate(options: {
  homePath: string;
  slug: string;
  previousVersionBundlePath: string;
  snapshotPath: string;
}): Promise<RollbackResult> {
  const { homePath, slug, previousVersionBundlePath, snapshotPath } = options;
  const appDir = join(homePath, 'apps', slug);

  if (!existsSync(appDir)) {
    return { success: false, dataRestored: false, error: `App "${slug}" not installed at ${appDir}` };
  }

  if (!existsSync(previousVersionBundlePath)) {
    return {
      success: false,
      dataRestored: false,
      error: `Previous version bundle not found: ${previousVersionBundlePath}`,
    };
  }

  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  await cp(previousVersionBundlePath, appDir, { recursive: true });

  let dataRestored = false;
  if (existsSync(snapshotPath)) {
    const appDataDir = join(homePath, 'data', slug);
    await rm(appDataDir, { recursive: true, force: true });
    await cp(snapshotPath, appDataDir, { recursive: true });
    dataRestored = true;
  }

  return { success: true, dataRestored };
}
