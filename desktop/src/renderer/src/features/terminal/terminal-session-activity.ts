const SESSION_DAY_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function relativeSessionActivity(updatedAt: string | undefined, now = Date.now()): string {
  if (!updatedAt) return "Activity unknown";
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return "Activity unknown";
  const elapsed = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return SESSION_DAY_FORMATTER.format(timestamp);
}
