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
    // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- intentional one-shot mount load of the cron-job list from the gateway; bounded by AbortSignal.timeout(10s) and run once with an empty dep array, so a data-fetching library would add no safety to this single static read
    fetch(`${GATEWAY_URL}/api/cron`, { signal: AbortSignal.timeout(10_000) })
      .then((res) => res.json())
      .then((data: CronJob[]) => setJobs(data))
      .catch((err: unknown) => {
        console.warn("[cron] Failed to fetch jobs:", err instanceof Error ? err.message : String(err));
      });
  }, []);

  return { jobs };
}
