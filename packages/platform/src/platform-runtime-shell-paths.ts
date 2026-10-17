import { SLACK_INSTALL_PATH } from '@matrix-os/contracts/slack-bridge';
import type { AppDomainIdentity } from './session-routing-identity.js';

/** Account/workspace setup must remain available before a customer VPS is ready. */
export function isPlatformRuntimeShellPath(path: string): boolean {
  return path === '/runtime' || path === '/onboarding/computer'
    || path === SLACK_INSTALL_PATH || path === '/slack/oauth/complete';
}

export function shouldServePlatformRuntimeShell(input: {
  isAppDomain: boolean;
  path: string;
  userId: string;
  identitySource?: AppDomainIdentity['source'];
}): boolean {
  return Boolean(input.isAppDomain && input.userId && isPlatformRuntimeShellPath(input.path)
    && input.identitySource !== 'mobile-session' && input.identitySource !== 'static-route');
}
