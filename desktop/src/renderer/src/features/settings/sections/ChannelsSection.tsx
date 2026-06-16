import { useEffect, useState } from "react";
import { useConnection } from "../../../stores/connection";
import { Card, Empty, SectionHeader } from "./section-kit";
import { StatusDot } from "../../../design/primitives";

interface ChannelStatus {
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

export default function ChannelsSection() {
  const api = useConnection((s) => s.api);
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .get<unknown>("/api/channels/status")
      .then((res) => {
        if (cancelled) return;
        setChannels(parseChannelStatusResponse(res));
      })
      .catch((err: unknown) => {
        console.warn("[settings] channels load failed:", err instanceof Error ? err.message : String(err));
        if (!cancelled) setError(true);
      });
    return () => { cancelled = true; };
  }, [api]);

  return (
    <>
      <SectionHeader title="Channels" description="Messaging surfaces connected to your agent." />
      <Card>
        {error ? <Empty text="Channels unavailable." /> : channels.length === 0 ? (
          <Empty text="No channels configured yet." />
        ) : (
          channels.map((c) => (
            <div key={c.name} className="flex items-center gap-2 text-sm">
              <StatusDot color={c.connected ? "var(--status-complete)" : "var(--status-todo)"} />
              <span className="flex-1 capitalize" style={{ color: "var(--text-primary)" }}>{c.name}</span>
              <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{c.connected ? "Connected" : "Off"}</span>
            </div>
          ))
        )}
      </Card>
    </>
  );
}
