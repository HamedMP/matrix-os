import type { UsageAgent } from "@matrix-os/contracts/ai-usage";
const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const standard = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
export const number = (n: number) => (n >= 1e6 ? compact : standard).format(n);
export const money = (n: number | null) =>
  n === null ? "Unavailable" : usd.format(n);
export const agentName = (agent: UsageAgent) =>
  agent === "claude" ? "Claude Code" : "Codex";

export function formatBytes(value: number) {
  const unit = Math.min(
    4,
    Math.max(0, Math.floor(Math.log10(Math.max(1, value)) / 3)),
  );
  return `${standard.format(value / 1000 ** unit)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
