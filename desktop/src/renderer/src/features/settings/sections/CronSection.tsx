import { useEffect, useState } from "react";
import { useConnection } from "../../../stores/connection";
import { Card, Empty, SectionHeader } from "./section-kit";

interface CronJob {
  id?: string;
  name?: string;
  schedule?: string;
  prompt?: string;
  enabled?: boolean;
}

function parse(value: unknown): CronJob[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { jobs?: unknown }).jobs)
      ? (value as { jobs: unknown[] }).jobs
      : value && typeof value === "object" && Array.isArray((value as { cron?: unknown }).cron)
        ? (value as { cron: unknown[] }).cron
        : [];
  return list.slice(0, 100).filter((r): r is CronJob => Boolean(r) && typeof r === "object");
}

export default function CronSection() {
  const api = useConnection((s) => s.api);
  const [state, setState] = useState<{ jobs: CronJob[]; error: boolean; loading: boolean }>({
    jobs: [],
    error: false,
    loading: Boolean(api),
  });

  useEffect(() => {
    if (!api) {
      setState((current) => ({ ...current, loading: false }));
      return;
    }
    let cancelled = false;
    setState((current) => ({ ...current, error: false, loading: true }));
    api.get<unknown>("/api/cron").then((res) => {
      if (!cancelled) {
        setState({ jobs: parse(res), error: false, loading: false });
      }
    }).catch((err: unknown) => {
      console.warn("[settings] cron load failed:", err instanceof Error ? err.message : String(err));
      if (!cancelled) setState((current) => ({ ...current, error: true, loading: false }));
    });
    return () => { cancelled = true; };
  }, [api]);

  return (
    <>
      <SectionHeader title="Schedules" description="Recurring agent jobs and heartbeats." />
      <Card>
        {state.loading ? <Empty text="Loading schedules..." /> : state.error ? <Empty text="Schedules unavailable." /> : state.jobs.length === 0 ? (
          <Empty text="No scheduled jobs." />
        ) : (
          state.jobs.map((j, i) => (
            <div key={j.id ?? i} className="flex flex-col gap-0.5 border-b pb-2 last:border-0 last:pb-0" style={{ borderColor: "var(--border-subtle)" }}>
              <div className="flex items-center justify-between">
                <span className="text-sm" style={{ color: "var(--text-primary)" }}>{j.name ?? j.prompt ?? j.id ?? "Job"}</span>
                <span className="font-mono text-xs" style={{ color: "var(--text-tertiary)" }}>{j.schedule ?? ""}</span>
              </div>
            </div>
          ))
        )}
      </Card>
    </>
  );
}
