import type { RuntimeSummary } from "@matrix-os/contracts";

/** Whether the runtime summary advertises a capability as enabled. */
export function capabilityEnabled(summary: RuntimeSummary, id: string): boolean {
  return summary.capabilities.some((capability) => capability.id === id && capability.enabled);
}
