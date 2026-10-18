import { describe, expect, it } from 'vitest';
import { isPlatformRuntimeShellPath, shouldServePlatformRuntimeShell } from '../../packages/platform/src/session-routing-middleware.js';
describe('Starter platform shell routing', () => {
  it.each(['/workspace', '/workspace/api/api/shell/bootstrap', '/__shared-workspace/api/workspace/actions'])('serves %s from the platform shell instead of an existing VPS', (path) => {
    expect(isPlatformRuntimeShellPath(path)).toBe(true);
    expect(shouldServePlatformRuntimeShell({ isAppDomain: true, path, userId: 'user_hamed', identitySource: 'auth' })).toBe(true);
  });
  it.each(['/vm/hamed', '/api/files', '/workspaces', '/workspace-other'])('preserves the existing routing of %s', (path) => {
    expect(isPlatformRuntimeShellPath(path)).toBe(false);
  });
});
