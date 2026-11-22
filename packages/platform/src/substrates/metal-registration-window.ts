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

/** Whether an owner's active runtime is a failed build the owner must retry from onboarding. */
export function isFailedRuntimeBuild(
  machine: { substrate: string; status: string; registrationTokenExpiresAt: string | null },
  at: Date,
): boolean {
  return machine.status === 'failed' || isMetalRegistrationExpired(machine, at);
}
