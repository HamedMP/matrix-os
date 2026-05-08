import type { StatusResponse } from './customer-vps.js';

export interface FleetMachineView extends StatusResponse {
  healthy: boolean;
}

export interface FleetHealthSummary {
  healthy: number;
  degraded: number;
  unreachable: number;
}

export interface FleetSummary {
  total: number;
  running: number;
  provisioning: number;
  failed: number;
  deleted: number;
  versionDistribution: Record<string, number>;
  healthSummary: FleetHealthSummary;
}

export function buildFleetSummary(machines: FleetMachineView[]): FleetSummary {
  let running = 0;
  let provisioning = 0;
  let failed = 0;
  let deleted = 0;
  let healthy = 0;
  let degraded = 0;
  let unreachable = 0;
  const versionDistribution: Record<string, number> = {};

  for (const m of machines) {
    switch (m.status) {
      case "running": running++; break;
      case "provisioning": case "recovering": provisioning++; break;
      case "failed": failed++; break;
      case "deleted": deleted++; break;
    }

    if (m.status === "running") {
      if (m.healthy) healthy++;
      else degraded++;
    } else {
      unreachable++;
    }

    const version = m.imageVersion ?? "unknown";
    versionDistribution[version] = (versionDistribution[version] ?? 0) + 1;
  }

  return {
    total: machines.length,
    running,
    provisioning,
    failed,
    deleted,
    versionDistribution,
    healthSummary: { healthy, degraded, unreachable },
  };
}
