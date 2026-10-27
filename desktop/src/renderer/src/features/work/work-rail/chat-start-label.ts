// Compact rail age for when a Chat started ("now", "5m", "3h", "2d", then a short date).
export function compactChatStartLabel(iso: string, nowMs: number): string {
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return "";
  const minutes = Math.floor(Math.max(0, nowMs - started) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(started).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function chatStartTitle(iso: string): string {
  const started = Date.parse(iso);
  return Number.isNaN(started) ? "" : `Started ${new Date(started).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}
