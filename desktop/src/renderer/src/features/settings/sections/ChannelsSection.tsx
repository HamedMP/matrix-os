import { useEffect, useState } from "react";
import { useConnection } from "../../../stores/connection";
import { Card, Empty, SectionHeader } from "./section-kit";
import { StatusDot } from "../../../design/primitives";

export default function ChannelsSection() {
  const api = useConnection((s) => s.api);
  const [channels, setChannels] = useState<Array<{ name: string; connected: boolean }>>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .get<unknown>("/api/channels/status")
      .then((res) => {
        if (cancelled) return;
        // Accept either a record { telegram: true } or an array of { name, connected }.
        const out: Array<{ name: string; connected: boolean }> = [];
        if (res && typeof res === "object" && !Array.isArray(res)) {
          for (const [name, v] of Object.entries(res as Record<string, unknown>)) {
            if (typeof v === "boolean") out.push({ name, connected: v });
            else if (v && typeof v === "object") out.push({ name, connected: Boolean((v as { connected?: unknown }).connected) });
          }
        }
        setChannels(out);
      })
      .catch(() => { if (!cancelled) setError(true); });
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
