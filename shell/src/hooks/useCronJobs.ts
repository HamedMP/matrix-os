"use client";

import { useEffect, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";

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

const GATEWAY_URL = getGatewayUrl();

export function useCronJobs() {
  const [jobs, setJobs] = useState<CronJob[]>([]);

  useEffect(() => {
    fetch(`${GATEWAY_URL}/api/cron`, { signal: AbortSignal.timeout(10_000) })
      .then((res) => res.json())
      .then((data: CronJob[]) => setJobs(data))
      .catch((err: unknown) => {
        console.warn("[cron] Failed to fetch jobs:", err instanceof Error ? err.message : String(err));
      });
  }, []);

  return { jobs };
}
