"use client";

import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getGatewayUrl } from "@/lib/gateway";
import { ClockIcon, PlusIcon, TrashIcon } from "lucide-react";

const GATEWAY = getGatewayUrl();

interface CronJob {
  id: string;
  name: string;
  message: string;
  schedule: {
    type: "interval" | "cron" | "once";
    intervalMs?: number;
    cron?: string;
    at?: string;
  };
  target?: { channel: string; chatId: string };
  createdAt: string;
}

function formatSchedule(schedule: CronJob["schedule"]): string {
  if (schedule.type === "interval" && schedule.intervalMs) {
    const minutes = Math.round(schedule.intervalMs / 60000);
    if (minutes >= 60) return `Every ${Math.round(minutes / 60)}h`;
    return `Every ${minutes}m`;
  }
  if (schedule.type === "cron" && schedule.cron) return schedule.cron;
  if (schedule.type === "once" && schedule.at) {
    return new Date(schedule.at).toLocaleString();
  }
  return "Unknown";
}

export function CronSection() {
  const [jobs, setJobs] = useState<CronJob[]>([]);

  useEffect(() => {
    fetch(`${GATEWAY}/api/cron`)
      .then((r) => r.ok ? r.json() : [])
      .then(setJobs)
      .catch(() => {});
  }, []);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Cron Jobs</h2>
        <Button size="sm" variant="outline" className="h-8 text-xs">
          <PlusIcon className="size-3 mr-1" />
          Add Job
        </Button>
      </div>

      {jobs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <ClockIcon className="size-8 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium">No cron jobs</p>
            <p className="text-xs text-muted-foreground mt-1">
              Schedule recurring tasks like daily summaries or reminders.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <Card key={job.id} className="gap-0">
              <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <ClockIcon className="size-4 text-primary" />
                    <CardTitle className="text-sm font-medium">{job.name}</CardTitle>
                    <Badge variant="secondary" className="text-xs font-mono">
                      {formatSchedule(job.schedule)}
                    </Badge>
                    {job.target?.channel && (
                      <Badge variant="outline" className="text-xs">
                        {job.target.channel}
                      </Badge>
                    )}
                  </div>
                  <Button variant="ghost" size="icon" className="size-7 text-muted-foreground">
                    <TrashIcon className="size-3" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1 ml-7 truncate">
                  {job.message}
                </p>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
