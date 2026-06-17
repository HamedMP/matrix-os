export interface ChannelStatus {
  name: string;
  connected: boolean;
}

export function parseChannelStatusResponse(value: unknown): ChannelStatus[] {
  const out: ChannelStatus[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { name?: unknown }).name === "string"
      ) {
        out.push({
          name: (item as { name: string }).name,
          connected: Boolean((item as { connected?: unknown }).connected),
        });
      }
    }
    return out;
  }
  if (value && typeof value === "object") {
    for (const [name, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "boolean") out.push({ name, connected: v });
      else if (v && typeof v === "object") out.push({ name, connected: Boolean((v as { connected?: unknown }).connected) });
    }
  }
  return out;
}
