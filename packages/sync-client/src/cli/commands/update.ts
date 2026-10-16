import { defineCommand } from 'citty';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isStandaloneRuntime } from '../standalone-runtime.js';
import { resolveCliVersion } from '../version.js';
import { compareCliVersions, latestCliRelease, updateStandaloneCli } from '../self-update.js';
import { formatCliError, formatCliSuccess } from '../output.js';
export function detectCliInstallMethod(input: { standalone: boolean; executable: string; moduleUrl: string }): 'homebrew' | 'standalone' | 'pnpm' | 'other' {
  const modulePath = fileURLToPath(input.moduleUrl);
  if (/\/Cellar\/matrix\//.test(modulePath) || (input.standalone && /\/Cellar\/matrix\//.test(input.executable))) return 'homebrew';
  if (input.standalone) return 'standalone';
  if (/\/pnpm\/global\//.test(modulePath)) return 'pnpm';
  return 'other';
}
export async function runCliUpdate(args: Record<string, unknown>): Promise<void> {
  try {
    const release = await latestCliRelease(), currentVersion = resolveCliVersion();
    const available = compareCliVersions(release.version, currentVersion) > 0;
    if (args.check === true || !available) {
      const data = { currentVersion, latestVersion: release.version, updateAvailable: available, updated: false };
      console.log(args.json === true ? formatCliSuccess(data) : available ? `Matrix CLI ${release.version} is available. Run matrix update.` : `Matrix CLI ${currentVersion} is up to date.`);
      return;
    }
    const method = detectCliInstallMethod({ standalone: isStandaloneRuntime(), executable: process.execPath, moduleUrl: import.meta.url });
    if (method === 'homebrew') {
      await promisify(execFile)('brew', ['upgrade', 'finnaai/tap/matrix'], { timeout: 300000, maxBuffer: 65536 });
    }
    else if (method === 'standalone') {
      await updateStandaloneCli({ executable: process.execPath, release, platform: process.platform, arch: process.arch });
    }
    else if (method === 'pnpm') {
      await promisify(execFile)('pnpm', ['add', '--global', `@finnaai/matrix@${release.version}`], { timeout: 300000, maxBuffer: 65536 });
    }
    else {
      console.error(args.json === true ? formatCliError('package_managed', 'Update this installation with its original package manager. Standalone installs support matrix update directly.') : 'Update this installation with its original package manager. Standalone installs support matrix update directly.');
      process.exitCode = 1;
      return;
    }
    if (method !== 'standalone') {
      const verified = await promisify(execFile)('matrix', ['--version'], { timeout: 15000, maxBuffer: 8192, env: { ...process.env, MATRIX_NO_TELEMETRY: '1' } });
      if (verified.stdout.trim() !== release.version)
        throw new Error('Installed CLI differs');
    }
    console.log(args.json === true ? formatCliSuccess({ previousVersion: currentVersion, latestVersion: release.version, updated: true }) : `Matrix CLI updated to ${release.version}. Your settings and sign-ins were preserved.`);
  }
  catch (error: unknown) {
    if (!(error instanceof Error))
      throw error;
    console.error(args.json === true ? formatCliError('update_failed', 'Matrix CLI could not update. Check the connection and installation permissions, then try again.') : 'Matrix CLI could not update. Check the connection and installation permissions, then try again.');
    process.exitCode = 1;
  }
}
export const updateCommand = defineCommand({
  meta: { name: 'update', description: 'Update this Matrix CLI to the latest stable release' },
  args: { check: { type: 'boolean', default: false, description: 'Check for an update without installing' }, json: { type: 'boolean', default: false } },
  run: async (ctx) => runCliUpdate(ctx.args),
});
