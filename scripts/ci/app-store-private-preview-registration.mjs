/** Guard operator staging registration using an exact, freshly read managed preview. */
export function validatePrivatePreviewRegistration({ owner, machine, expectedOwnerId, expectedPr, expectedVersion, installedBundleVersion, expectedGitCommit, installedGitCommit, membershipVerified, now = new Date() }) {
  const deny = () => { throw new Error('Private preview staging registration is not eligible'); };
  if (!/^user_[A-Za-z0-9_-]{1,150}$/.test(expectedOwnerId ?? '') || !Number.isSafeInteger(expectedPr)
    || expectedPr < 1 || typeof expectedVersion !== 'string' || !expectedVersion || expectedVersion.length > 200
    || !/^[a-f0-9]{40}$/i.test(expectedGitCommit ?? '') || installedGitCommit !== expectedGitCommit) deny();
  if (membershipVerified !== true || owner?.clerk_id !== expectedOwnerId || owner.status !== 'active'
    || machine?.clerk_user_id !== expectedOwnerId || machine.provisioning_class !== 'private-preview'
    || machine.status !== 'running' || machine.deleted_at !== null || machine.source_pr !== expectedPr
    || !Array.isArray(machine.access_clerk_user_ids) || machine.access_clerk_user_ids.length !== 0
    || !new RegExp(`^pv-${expectedPr}-[a-f0-9]{8}$`).test(machine.handle ?? '')
    || machine.runtime_slot !== machine.handle || !Number.isSafeInteger(machine.runtime_token_epoch) || machine.runtime_token_epoch < 1
    || machine.confirmed_bundle_version !== expectedVersion || installedBundleVersion !== expectedVersion) deny();
  const provisioned = Date.parse(machine.provisioned_at);
  if (!Number.isFinite(provisioned) || !Number.isFinite(now.getTime()) || provisioned > now.getTime()
    || provisioned + 72 * 60 * 60 * 1000 <= now.getTime()) deny();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(machine.machine_id ?? '')) deny();
  return { ownerId: expectedOwnerId, machineId: machine.machine_id, handle: machine.handle };
}
