"use client";

import { Badge } from "@/components/ui/badge";
import type { CronJob } from "@/hooks/useCronJobs";

function describeSchedule(job: CronJob): string {
  const s = job.schedule;
  switch (s.type) {
    case "cron":
      return s.cron;
    case "interval": {
      const mins = Math.round(s.intervalMs / 60_000);
      if (mins < 60) return `Every ${mins}m`;
      return `Every ${Math.round(mins / 60)}h`;
    }
    case "once":
      return new Date(s.at).toLocaleString();
  }
}

const typeVariant: Record<string, "default" | "secondary" | "outline"> = {
  cron: "default",
  interval: "secondary",
  once: "outline",
};

interface CronCardProps {
  job: CronJob;
}

export function CronCard({ job }: CronCardProps) {
  return (
    <div className="rounded border border-border bg-card/50 p-2 text-xs">
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-medium">{job.name}</span>
        <Badge
          variant={typeVariant[job.schedule.type] ?? "outline"}
          className="text-[10px] px-1.5 py-0 shrink-0"
        >
          {job.schedule.type}
        </Badge>
      </div>
      <div className="flex items-center justify-between gap-1 mt-1 text-muted-foreground text-[10px]">
        <span className="truncate">{describeSchedule(job)}</span>
        <span className="truncate ml-auto max-w-[50%]">{job.message}</span>
      </div>
    </div>
  );
}
