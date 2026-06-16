import { useEffect, useState } from "react";
import { useConnection } from "../../../stores/connection";
import { Card, Empty, SectionHeader } from "./section-kit";
import { StatusDot } from "../../../design/primitives";

interface Integration {
  service: string;
  label?: string;
  connected?: boolean;
}

function parse(value: unknown): Integration[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { integrations?: unknown }).integrations)
      ? (value as { integrations: unknown[] }).integrations
      : [];
  const out: Integration[] = [];
  for (const raw of list.slice(0, 100)) {
    if (raw && typeof raw === "object" && typeof (raw as Integration).service === "string") {
      const r = raw as Integration;
      out.push({ service: r.service, label: r.label, connected: r.connected });
    }
  }
  return out;
}

export default function IntegrationsSection() {
  const api = useConnection((s) => s.api);
  const [items, setItems] = useState<Integration[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.get<unknown>("/api/integrations").then((res) => { if (!cancelled) setItems(parse(res)); }).catch((err: unknown) => {
      console.warn("[settings] integrations load failed:", err instanceof Error ? err.message : String(err));
      if (!cancelled) setError(true);
    });
    return () => { cancelled = true; };
  }, [api]);

  return (
    <>
      <SectionHeader title="Integrations" description="External services your agent can use." />
      <Card>
        {error ? <Empty text="Integrations unavailable." /> : items.length === 0 ? (
          <Empty text="No integrations connected yet." />
        ) : (
          items.map((i) => (
            <div key={i.service} className="flex items-center gap-2 text-sm">
              <StatusDot color={i.connected ? "var(--status-complete)" : "var(--status-todo)"} />
              <span className="flex-1" style={{ color: "var(--text-primary)" }}>{i.label ?? i.service}</span>
              <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{i.connected ? "Connected" : "Available"}</span>
            </div>
          ))
        )}
      </Card>
    </>
  );
}
