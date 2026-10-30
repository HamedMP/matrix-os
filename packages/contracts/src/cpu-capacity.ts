import { z } from "zod/v4";

export type CpuObservation<T> = { status: "known"; value: T } | { status: "unavailable" };
export interface CpuObservations {
  visibleLogicalCpuCount: number;
  affinity: CpuObservation<number>;
  /** Eligible CPU counts after intersecting each cpuset with process affinity. */
  cpusets: CpuObservation<number | null>[];
  quotas: CpuObservation<{ quotaMicros: number; periodMicros: number } | null>[];
}

export const CpuCapacitySchema = z.object({
  visibleLogicalCpuCount: z.number().int().nonnegative(),
  effectiveCpuCapacity: z.number().positive().nullable(),
  constraintStatus: z.enum(["complete", "unavailable"]),
}).refine(value => value.constraintStatus === "unavailable"
  ? value.effectiveCpuCapacity === null
  : value.effectiveCpuCapacity !== null && value.effectiveCpuCapacity <= value.visibleLogicalCpuCount);
export type CpuCapacity = z.infer<typeof CpuCapacitySchema>;

/** CPU-time capacity, not a physical-core count or a throughput guarantee. */
export function deriveCpuCapacity(input: CpuObservations): CpuCapacity {
  const visible = Number.isSafeInteger(input.visibleLogicalCpuCount) && input.visibleLogicalCpuCount >= 0
    ? input.visibleLogicalCpuCount : 0;
  const unknown: CpuCapacity = { visibleLogicalCpuCount: visible, effectiveCpuCapacity: null, constraintStatus: "unavailable" };
  if (!visible || input.affinity.status !== "known" || !input.cpusets.length || !input.quotas.length) return unknown;
  const bounds = [visible, input.affinity.value];
  for (const cpuset of input.cpusets) {
    if (cpuset.status !== "known") return unknown;
    if (cpuset.value !== null) bounds.push(cpuset.value);
  }
  for (const quota of input.quotas) {
    if (quota.status !== "known") return unknown;
    if (quota.value !== null) {
      const { quotaMicros, periodMicros } = quota.value;
      if (!Number.isFinite(quotaMicros) || quotaMicros <= 0 || !Number.isFinite(periodMicros) || periodMicros <= 0) return unknown;
      bounds.push(quotaMicros / periodMicros);
    }
  }
  if (bounds.some(value => !Number.isFinite(value) || value <= 0)) return unknown;
  return { visibleLogicalCpuCount: visible, effectiveCpuCapacity: Math.min(...bounds), constraintStatus: "complete" };
}

/** One presentation for API provenance and older gateways without provenance. */
export function presentCpuCapacity(capacity: unknown, legacyVisibleCount: unknown, load?: number) {
  const parsed = CpuCapacitySchema.safeParse(capacity);
  const visible = parsed.success ? parsed.data.visibleLogicalCpuCount
    : typeof legacyVisibleCount === "number" && Number.isSafeInteger(legacyVisibleCount) && legacyVisibleCount >= 0
      ? legacyVisibleCount : null;
  const effective = parsed.success ? parsed.data.effectiveCpuCapacity : null;
  const capacityText = effective === null ? "Effective CPU capacity unknown" : `${effective} effective vCPUs`;
  const topologyText = visible === null ? "Visible logical CPU count unknown" : `${visible} visible logical CPUs`;
  const loadPercent = effective !== null && typeof load === "number" && Number.isFinite(load) && load >= 0
    ? Math.min(100, Math.round(load / effective * 100)) : null;
  return { capacityText, topologyText, summary: `${capacityText} · ${topologyText}`, loadPercent };
}
