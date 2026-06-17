/** Human byte size (e.g. 1.5 GB) from a byte count. */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const rounded = value >= 10 || i === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
}

export function portList(ports: unknown[] | undefined): string {
  if (!ports || ports.length === 0) return "";
  const values = ports
    .map((p) => {
      const value =
        typeof p === "object" && p && "port" in p
          ? (p as { port: unknown }).port
          : p;
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
      return null;
    })
    .filter((p): p is string => p !== null);
  return values.length ? values.join(", ") : "";
}
