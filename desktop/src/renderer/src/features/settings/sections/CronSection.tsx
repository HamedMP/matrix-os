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
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.get<unknown>("/api/cron").then((res) => {
      if (!cancelled) {
        setJobs(parse(res));
        setError(false);
      }
    }).catch((err: unknown) => {
      console.warn("[settings] cron load failed:", err instanceof Error ? err.message : String(err));
      if (!cancelled) setError(true);
    });
    return () => { cancelled = true; };
  }, [api]);

  return (
    <>
      <SectionHeader title="Schedules" description="Recurring agent jobs and heartbeats." />
      <Card>
        {error ? <Empty text="Schedules unavailable." /> : jobs.length === 0 ? (
          <Empty text="No scheduled jobs." />
        ) : (
          jobs.map((j, i) => (
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
