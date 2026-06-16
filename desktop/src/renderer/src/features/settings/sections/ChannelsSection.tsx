import { useEffect, useState } from "react";
import { useConnection } from "../../../stores/connection";
import { Card, Empty, SectionHeader } from "./section-kit";
import { StatusDot } from "../../../design/primitives";
import { parseChannelStatusResponse, type ChannelStatus } from "./channel-status";

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
        setError(false);
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
