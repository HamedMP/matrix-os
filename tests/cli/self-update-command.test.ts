import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ latest: vi.fn(), install: vi.fn(), version: vi.fn(), standalone: vi.fn() }));
vi.mock('../../packages/sync-client/src/cli/self-update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/sync-client/src/cli/self-update.js')>();
  return { ...actual, latestCliRelease: mocks.latest, updateStandaloneCli: mocks.install };
});
vi.mock('../../packages/sync-client/src/cli/version.js', () => ({ resolveCliVersion: mocks.version }));
vi.mock('../../packages/sync-client/src/cli/standalone-runtime.js', () => ({ isStandaloneRuntime: mocks.standalone }));
import { runCliUpdate, updateCommand, detectCliInstallMethod } from '../../packages/sync-client/src/cli/commands/update.js';
beforeEach(() => { mocks.latest.mockResolvedValue({ version: '0.3.22', assets: [] }); mocks.version.mockReturnValue('0.3.21'); mocks.standalone.mockReturnValue(true); mocks.install.mockResolvedValue(undefined); vi.spyOn(console, 'log').mockImplementation(() => { }); vi.spyOn(console, 'error').mockImplementation(() => { }); process.exitCode = undefined; });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); process.exitCode = undefined; });
describe('matrix update command', () => {
  it('offers an explicit read-only check', async () => { const args = typeof updateCommand.args === 'function' ? await updateCommand.args() : await updateCommand.args; expect(args?.check).toMatchObject({ type: 'boolean', default: false }); });
  it('checks without mutating the installation', async () => { await runCliUpdate({ check: true, json: true }); expect(mocks.install).not.toHaveBeenCalled(); expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({ ok: true, data: { updateAvailable: true, updated: false, currentVersion: '0.3.21', latestVersion: '0.3.22' } }); });
  it('updates the exact standalone executable', async () => { await runCliUpdate({ json: true }); expect(mocks.install).toHaveBeenCalledExactlyOnceWith({ executable: process.execPath, release: { version: '0.3.22', assets: [] }, platform: process.platform, arch: process.arch }); expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({ ok: true, data: { updated: true } }); });
  it.each(['0.3.22', '0.4.0'])('does not reinstall or downgrade current %s', async (version) => { mocks.version.mockReturnValue(version); await runCliUpdate({}); expect(mocks.install).not.toHaveBeenCalled(); expect(process.exitCode).toBeUndefined(); });
  it('fails safely without leaking installer errors or file paths', async () => { mocks.install.mockRejectedValue(new Error('private token /home/owner/secret')); await runCliUpdate({ json: true }); const text = String(vi.mocked(console.error).mock.calls[0]![0]); expect(JSON.parse(text)).toMatchObject({ error: { code: 'update_failed' } }); expect(text).not.toMatch(/private token|\/home\/owner/); expect(process.exitCode).toBe(1); });
  it('does not alter a source or unsupported package-managed installation', async () => { mocks.standalone.mockReturnValue(false); await runCliUpdate({ json: true }); expect(mocks.install).not.toHaveBeenCalled(); expect(JSON.parse(vi.mocked(console.error).mock.calls[0]![0])).toMatchObject({ error: { code: 'package_managed' } }); expect(process.exitCode).toBe(1); });
  it('reports metadata failures without claiming an update', async () => { mocks.latest.mockRejectedValue(new Error('registry unavailable')); await runCliUpdate({}); expect(mocks.install).not.toHaveBeenCalled(); expect(console.log).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1); });
});

describe('installation owner detection', () => {
  it('recognizes the shipped Homebrew Node package independently of Node itself', () => {
    expect(detectCliInstallMethod({ standalone: false, executable: '/opt/homebrew/Cellar/node@20/20.19.0/bin/node', moduleUrl: 'file:///opt/homebrew/Cellar/matrix/0.3.21/libexec/lib/node_modules/@finnaai/matrix/src/cli/commands/update.ts' })).toBe('homebrew');
    expect(detectCliInstallMethod({ standalone: false, executable: '/home/linuxbrew/.linuxbrew/Cellar/node/24/bin/node', moduleUrl: 'file:///home/linuxbrew/.linuxbrew/Cellar/matrix/0.3.21/libexec/lib/node_modules/@finnaai/matrix/src/cli/commands/update.ts' })).toBe('homebrew');
  });
  it('does not confuse Homebrew Node with a Homebrew Matrix installation', () => {
    expect(detectCliInstallMethod({ standalone: false, executable: '/opt/homebrew/Cellar/node/24/bin/node', moduleUrl: 'file:///projects/matrix-os/packages/sync-client/src/cli/commands/update.ts' })).toBe('other');
  });
});
