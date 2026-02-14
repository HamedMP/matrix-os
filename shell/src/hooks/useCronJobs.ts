"use client";

import { useEffect, useState } from "react";

export type CronSchedule =
  | { type: "cron"; cron: string }
  | { type: "interval"; intervalMs: number }
  | { type: "once"; at: string };

export interface CronJob {
  id: string;
  name: string;
  message: string;
  schedule: CronSchedule;
  createdAt: string;
}

const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

export function useCronJobs() {
  const [jobs, setJobs] = useState<CronJob[]>([]);

  useEffect(() => {
    fetch(`${GATEWAY_URL}/api/cron`)
      .then((res) => res.json())
      .then((data: CronJob[]) => setJobs(data))
      .catch(() => {});
  }, []);

  return { jobs };
}
