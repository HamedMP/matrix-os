import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useConnection } from "../../../stores/connection";
import { Card, Empty, SettingsSectionHeader } from "./section-kit";
import { cronQueryOptions } from "../cron.api";

export default function CronSection() {
  const api = useConnection((s) => s.api);
  const platformHost = useConnection((s) => s.platformHost);
  const authGeneration = useConnection((s) => s.authGeneration);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const scope = useMemo(() => ({ platformHost, authGeneration, runtimeSlot }), [platformHost, authGeneration, runtimeSlot]);
  const { data: jobs = [], isError, isPending } = useQuery({
    ...cronQueryOptions(api ?? { get: async () => [] } as never, scope),
    enabled: api !== null,
  });

  return (
    <>
      <SettingsSectionHeader title="Schedules" description="Recurring agent jobs and heartbeats." />
      <Card>
        {api !== null && isPending ? <Empty text="Loading schedules..." /> : isError ? <Empty text="Schedules unavailable." /> : jobs.length === 0 ? (
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
