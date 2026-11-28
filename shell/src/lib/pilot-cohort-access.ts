import { isPilotCohortMember, type PilotCohortPolicy } from '@matrix-os/contracts';
import { isPlatformUserProofValid } from './platform-preview-access';

/** Authentication screens and fixed public assets carry no application authority. */
export function isPublicPilotShellPath(pathname: string): boolean {
  return pathname === '/health' || pathname === '/manifest.json'
    || pathname === '/og.png' || pathname === '/favicon.ico'
    || pathname === '/sign-in' || pathname.startsWith('/sign-in/');
}

/** A platform bearer alone cannot establish which pilot member owns the request. */
export function canPilotPlatformActorAccessShell(input: {
  policy: PilotCohortPolicy;
  userId: string | null;
  proof: string | null;
  token: string | undefined;
}): boolean {
  if (input.policy.status === 'disabled') return true;
  if (!input.userId || !input.token || !isPilotCohortMember(input.policy, input.userId)) return false;
  return isPlatformUserProofValid({ platformToken: input.token,
    platformUserId: input.userId, platformUserProof: input.proof });
}
