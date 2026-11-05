import { assert, assertNoUnits, command } from "./control.mjs";
import { preparePlacement } from "./placement.mjs";
import { supervisorArgs } from "./proof.mjs";

/** Caller holds the protected namespace reservation; no mutation precedes ancestry checks. */
export async function submitSupervisor(config, token, template, ledger, run = command) {
  await preparePlacement(config, { readOnly: true });
  await assertNoUnits(config, run);
  const placement = await preparePlacement(config);
  await assertNoUnits(config, run);
  ledger.submitted();
  const result = await run("/usr/bin/systemd-run", supervisorArgs(config, token, template), 30_000);
  assert(result.code === 0, "owned_supervisor_start_failed");
  return { identity: await ledger.captureSupervisor(), placement };
}
