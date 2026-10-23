export function formatSiteDate(timestamp: string): string {
  return `${new Date(timestamp).toLocaleString("en-US", {
    timeZone: "UTC", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  })} UTC`;
}
