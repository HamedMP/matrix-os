import { assert, assertNoUnits, command } from "./control.mjs";
import { preparePlacement } from "./placement.mjs";
import { supervisorArgs } from "./proof.mjs";

/** Caller holds the protected namespace reservation; no mutation precedes ancestry checks. */
export async function submitSupervisor(config, token, template, ledger, run = command, reservation, check = () => {}) {
  await preparePlacement(config, { readOnly: true });
  await assertNoUnits(config, run);
  assert(reservation && typeof reservation.verify === "function", "placement_reservation_required");
  await reservation.verify();
  await assertNoUnits(config, run);
  await reservation.verify();
  check();
  ledger.submitted();
  const result = await run("/usr/bin/systemd-run", supervisorArgs(config, token, template), 30_000);
  assert(result.code === 0, "owned_supervisor_start_failed");
  return { identity: await ledger.captureSupervisor(), placement: { leaves: reservation.leaves } };
}
