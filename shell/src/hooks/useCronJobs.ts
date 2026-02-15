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
    fetch(`${GATEWAY_URL}/api/cron`)
      .then((res) => res.json())
      .then((data: CronJob[]) => setJobs(data))
      .catch(() => {});
  }, []);

  return { jobs };
}
