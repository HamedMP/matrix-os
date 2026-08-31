import type { AiProviderSnapshotV3, ProviderHarnessKind } from "@matrix-os/contracts";

export function resolveProviderSettingsDriverId(input: {
  driverId: string;
  harness: ProviderHarnessKind;
  canonical: AiProviderSnapshotV3;
}): string {
  if (input.harness === "claude"
    && input.driverId === "kernel"
    && input.canonical.drivers.some((driver) => driver.id === "claude_code")) {
    return "claude_code";
  }
  return input.driverId;
}
