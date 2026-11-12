import type { UsageAgent, UsageHistory } from "@matrix-os/contracts/ai-usage";
/** Refresh may remove a previously selected year. Resolve an available report before computing totals. */
export function usageSelection(history: UsageHistory | undefined, agent: UsageAgent | "", range: string) {
  const report = history?.reports.find(r => r.id === range && r.agent === agent)
    ?? history?.reports.find(r => r.id === "all" && r.agent === agent)
    ?? history?.reports.find(r => r.agent === agent);
  const effectiveRange = report?.id ?? (["7", "30", "90", "365"].includes(range) ? range : "365");
  return { report, effectiveRange, days: report?.days ?? Number(effectiveRange) };
}
