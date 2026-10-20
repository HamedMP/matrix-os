import { eligible, sharedMachine, TTL_MS } from "./preview-review-model.mjs";

// Legacy runtimes have no lease to retire. Keep their physical tombstone in
// capacity inventory until provider proof permits a fresh, full-lived request.
export async function retireExpiredLegacy({ prs, leases, machines, pendingPrs, owner, now, platform }) {
  for (const pr of prs) {
    if (!eligible(pr) || leases.some(row => row.payload.pr === pr.number)
      || pendingPrs.includes(pr.number)) continue;
    const targets = machines.filter(machine => sharedMachine(machine) && machine.handle === `pr-${pr.number}`);
    const target = targets[0];
    if (targets.length !== 1 || target.clerkUserId !== owner
      || !(Date.parse(target.provisionedAt) + TTL_MS <= now)) continue;
    await platform.remove(target);
    machines = await platform.fleet();
    if (!(await platform.deletionConfirmed(pr.number, owner))) break;
  }
  return machines;
}
