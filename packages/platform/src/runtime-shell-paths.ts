import { isStarterWorkspacePath } from '@matrix-os/contracts/starter-computers';
import type { AppDomainIdentity } from './session-routing-identity.js';

export function isPlatformRuntimeShellPath(path: string): boolean {
  return path === '/runtime' || path === '/onboarding/computer' || isStarterWorkspacePath(path);
}
export function shouldServePlatformRuntimeShell(input: {
  isAppDomain: boolean; path: string; userId: string; identitySource?: AppDomainIdentity['source'];
}): boolean {
  return Boolean(input.isAppDomain && input.userId && isPlatformRuntimeShellPath(input.path)
    && input.identitySource !== 'mobile-session' && input.identitySource !== 'static-route');
}
/** Error documents never interpolate arbitrary nested workspace paths into HTML. */
export function platformRuntimeShellRetryPath(path: string): string {
  return isStarterWorkspacePath(path) ? '/workspace' : path === '/onboarding/computer' ? path : '/runtime';
}
