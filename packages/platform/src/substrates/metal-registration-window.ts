/**
 * A metal runtime still provisioning after its registration window closed: its
 * guest never registered (first boot failed) and never will, since registration
 * refuses an expired token. It is as failed as a `failed` row.
 */
export function isMetalRegistrationExpired(
  machine: { substrate: string; status: string; registrationTokenExpiresAt: string | null },
  at: Date,
): boolean {
  return machine.substrate === 'metal' && machine.status === 'provisioning'
    && machine.registrationTokenExpiresAt !== null
    && Date.parse(machine.registrationTokenExpiresAt) < at.getTime();
}

type FirstBuildFields = {
  substrate: string;
  status: string;
  registrationTokenExpiresAt: string | null;
  lastSeenAt: string | null;
  recoveryOldServerId: number | null;
};

/**
 * Whether a runtime never registered: registration stamps lastSeenAt, and a
 * recovery (which resets lastSeenAt) keeps its predecessor server id. A
 * computer that once ran is not a first build, whatever its failure.
 */
export function neverRegistered(machine: Pick<FirstBuildFields, 'lastSeenAt' | 'recoveryOldServerId'>): boolean {
  return (machine.lastSeenAt ?? null) === null && (machine.recoveryOldServerId ?? null) === null;
}

/**
 * Whether an owner's active runtime is a failed *first* build, which the owner
 * retries from onboarding. A computer that ran and later failed (a failed
 * recovery, a lost server) is not: retrying would retire its server.
 */
export function isFailedRuntimeBuild(machine: FirstBuildFields, at: Date): boolean {
  if (!neverRegistered(machine)) return false;
  return machine.status === 'failed' || isMetalRegistrationExpired(machine, at);
}
