// Display formatting for browser metadata: byte sizes, Finder-style
// today/yesterday dates, and the size-column label for files and folders.

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function formatBytes(sizeBytes: number | undefined): string {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) return "–";
  let value = sizeBytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded =
    unit === 0 || value >= 100 ? Math.round(value).toString() : (Math.round(value * 10) / 10).toString();
  return `${rounded} ${UNITS[unit]}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// "Today 14:30" / "Yesterday 09:05" / "12 Mar 2026". `now` is injectable so
// formatting stays deterministic under test and around midnight.
export function formatModified(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "–";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "–";
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (isSameDay(date, now)) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return `Yesterday ${time}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// Size column: files show their byte size, folders their item count when the
// gateway provides it, otherwise a dash — same convention as Finder's list.
export function formatEntrySize(entry: {
  type: "file" | "directory";
  sizeBytes?: number;
  children?: number;
}): string {
  if (entry.type === "directory") {
    if (typeof entry.children === "number") return entry.children === 1 ? "1 item" : `${entry.children} items`;
    return "–";
  }
  return formatBytes(entry.sizeBytes);
}
