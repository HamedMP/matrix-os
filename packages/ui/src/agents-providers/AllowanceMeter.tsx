import type { ProviderUsage } from "@matrix-os/contracts";

export function AllowanceMeter({ label, usage }: { label: string; usage: ProviderUsage }) {
  if (usage.kind !== "subscription_allowance") return null;
  const remainingBasisPoints = 10000 - usage.usedBasisPoints;
  return (
    <progress
      aria-label={`${label} remaining allowance`}
      aria-valuetext={`${Math.round(remainingBasisPoints / 100)}% remaining`}
      max={10000}
      value={remainingBasisPoints}
    />
  );
}
