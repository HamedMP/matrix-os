import { totalmem } from "node:os";
import type { VmRecord } from "./vm-store.js";

const MiB = 1024 ** 2;
const HOST_RESERVE_MIB = 32_768;
const PER_VMM_RESERVE_MIB = 256;

export function hostVmMemoryBudgetMiB(): number {
  const totalMiB = Math.floor(totalmem() / MiB);
  return Math.max(0, totalMiB - HOST_RESERVE_MIB);
}

export function fitsVmMemory(
  budgetMiB: number,
  records: readonly VmRecord[],
  vmId: string | undefined,
  requestedMiB: number,
): boolean {
  let committedMiB = requestedMiB + PER_VMM_RESERVE_MIB;
  for (const record of records) {
    if (record.id === vmId || record.state === "suspended") continue;
    if (record.state === "stopped" && record.memoryReservationMiB === undefined) continue;
    // A failed transition can leave a VMM alive. Keep its reservation until
    // hostd observes it off, stops it, or destroys it.
    committedMiB += (record.memoryReservationMiB ?? record.maxMiB) + PER_VMM_RESERVE_MIB;
  }
  return committedMiB <= budgetMiB;
}
