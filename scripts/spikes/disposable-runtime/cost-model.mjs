// Published rates and hypothetical workload; this does not benchmark providers.
import { pathToFileURL } from "node:url";

function number(value, name, { positive = false, integer = false, max = 1e12 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      (positive && value === 0) || (integer && !Number.isSafeInteger(value)) || value > max) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
const count = (n, name) => number(n, name, { integer: true });
const positive = (n, name) => number(n, name, { positive: true });
const roundUp = (seconds, quantum) => Math.ceil(seconds / quantum) * quantum;

// Each entry is a DIFFERENT server creation, wholly within ONE billing month.
export function vpsCost(lifetimesHours, hourlyUsd, monthlyUsd) {
  if (!Array.isArray(lifetimesHours) || lifetimesHours.length > 100_000) throw new Error("Invalid lifetimes");
  positive(hourlyUsd, "hourlyUsd");
  positive(monthlyUsd, "monthlyUsd");
  return lifetimesHours.reduce((result, hours) => {
    number(hours, "lifetime", { max: 744 });
    result.billedHours += Math.ceil(hours);
    result.usd += Math.min(Math.ceil(hours) * hourlyUsd, monthlyUsd);
    return result;
  }, { billedHours: 0, usd: 0 });
}

export function poolCost(options) {
  const { hostMemoryGiB, reservedMemoryGiB, runtimeMemoryGiB, hostVcpu,
    reservedVcpu, runtimeVcpuBudget, monthlyHostUsd, monthHours,
    targetOccupancy, residentHours, peakConcurrent, minHosts } = options;
  for (const [key, value] of Object.entries({ hostMemoryGiB, reservedMemoryGiB,
    runtimeMemoryGiB, hostVcpu, reservedVcpu, runtimeVcpuBudget, monthlyHostUsd,
    monthHours, targetOccupancy, residentHours, peakConcurrent, minHosts })) number(value, key);
  for (const key of ["hostMemoryGiB", "runtimeMemoryGiB", "hostVcpu", "runtimeVcpuBudget",
    "monthlyHostUsd", "monthHours", "targetOccupancy"]) positive(options[key], key);
  count(peakConcurrent, "peakConcurrent");
  count(minHosts, "minHosts");
  if (targetOccupancy > 1 || monthHours > 744) throw new Error("Invalid pool policy");
  const slotsPerHost = Math.min(
    Math.floor((hostMemoryGiB - reservedMemoryGiB) / runtimeMemoryGiB),
    Math.floor((hostVcpu - reservedVcpu) / runtimeVcpuBudget),
  );
  if (slotsPerHost < 1 || !Number.isFinite(slotsPerHost)) throw new Error("No runtime capacity");
  const hosts = Math.max(minHosts, Math.ceil(peakConcurrent / slotsPerHost),
    Math.ceil(residentHours / (slotsPerHost * monthHours * targetOccupancy)));
  const paidSlotHours = hosts * slotsPerHost * monthHours;
  const usd = hosts * monthlyHostUsd;
  return { hosts, slotsPerHost, concurrentSlots: hosts * slotsPerHost, paidSlotHours,
    idleSlotHours: paidSlotHours - residentHours,
    occupancy: paidSlotHours ? residentHours / paidSlotHours : 0,
    usd, usdPerResidentHour: residentHours ? usd / residentHours : null };
}

// Cloud Run Tier 1 us-central1 list rates. Concurrency=1, no minimum instances.
export function cloudRunCost({ mode, sessions, secondsPerSession, memoryGiB, vcpu }) {
  count(sessions, "sessions");
  number(secondsPerSession, "secondsPerSession");
  positive(memoryGiB, "memoryGiB");
  positive(vcpu, "vcpu");
  if (!["request", "instance"].includes(mode)) throw new Error("Invalid billing mode");
  const billedSeconds = sessions * (mode === "instance" && secondsPerSession > 0
    ? Math.max(60, roundUp(secondsPerSession, 0.1)) : roundUp(secondsPerSession, 0.1));
  const cpuRate = mode === "request" ? 0.000024 : 0.000018;
  const memoryRate = mode === "request" ? 0.0000025 : 0.000002;
  const requestUsd = mode === "request" ? sessions * 0.40 / 1_000_000 : 0;
  return { billedSeconds, usd: billedSeconds * (vcpu * cpuRate + memoryGiB * memoryRate) + requestUsd };
}

// Lambda default on-demand x86 us-east-1, excluding shared free allowances.
export function lambdaCost({ invocations, secondsPerInvocation, memoryGiB, scratchGiB }) {
  count(invocations, "invocations");
  number(secondsPerInvocation, "secondsPerInvocation", { max: 900 });
  number(memoryGiB, "memoryGiB", { positive: true, max: 10 });
  number(scratchGiB, "scratchGiB", { max: 10 });
  if (memoryGiB < 0.125 || scratchGiB < 0.5) throw new Error("Invalid Lambda size");
  const billedSeconds = invocations * roundUp(secondsPerInvocation, 0.001);
  return { billedSeconds, usd: billedSeconds * memoryGiB * 0.0000166667 +
    invocations * 0.20 / 1_000_000 + billedSeconds * (scratchGiB - 0.5) * 0.0000000309 };
}

// Cloudflare Containers: active CPU; provisioned memory and disk while resident.
export function cloudflareCost({ sessions, secondsPerSession, cpuSecondsPerSession, memoryGiB, diskGB }) {
  count(sessions, "sessions");
  number(secondsPerSession, "secondsPerSession");
  number(cpuSecondsPerSession, "cpuSecondsPerSession");
  positive(memoryGiB, "memoryGiB");
  positive(diskGB, "diskGB");
  const billedSeconds = sessions * roundUp(secondsPerSession, 0.01);
  return { billedSeconds, usd: sessions * roundUp(cpuSecondsPerSession, 0.01) * 0.000020 +
    billedSeconds * (memoryGiB * 0.0000025 + diskGB * 0.00000007) };
}

export function scenarios() {
  const poolAssumptions = { hostMemoryGiB: 8, reservedMemoryGiB: 1,
    runtimeMemoryGiB: 2, hostVcpu: 4, reservedVcpu: 1, runtimeVcpuBudget: 1,
    monthlyHostUsd: 9.99, monthHours: 730, targetOccupancy: 0.5, minHosts: 1 };
  const plans = {};
  for (const [name, sessions, workMinutes, peakFraction] of [
    ["free", 20, 5, 0.05], ["starter", 60, 20, 0.10],
  ]) {
    const lifecycleMinutes = 1;
    const idleMinutes = 5;
    const busySeconds = (workMinutes + lifecycleMinutes) * 60;
    const residentSeconds = busySeconds + idleMinutes * 60;
    const workHours = sessions * workMinutes / 60;
    const residentHours = sessions * residentSeconds / 3600;
    const ephemeral = vpsCost(Array(sessions).fill(residentSeconds / 3600), 0.0104, 6.49);
    const invocationCount = sessions * Math.ceil(workMinutes / 5);
    const lambda = lambdaCost({ invocations: invocationCount, secondsPerInvocation: 360,
      memoryGiB: 2, scratchGiB: 0.5 });
    const request = cloudRunCost({ mode: "request", sessions, secondsPerSession: busySeconds,
      memoryGiB: 2, vcpu: 1 });
    const instance = cloudRunCost({ mode: "instance", sessions, secondsPerSession: residentSeconds,
      memoryGiB: 2, vcpu: 1 });
    const cloudflare = cloudflareCost({ sessions, secondsPerSession: residentSeconds,
      cpuSecondsPerSession: busySeconds * 0.2, memoryGiB: 4, diskGB: 8 });
    plans[name] = { assumptions: { sessions, workMinutes, lifecycleMinutes, idleMinutes,
      memoryGiB: 2, vcpu: 1, peakFraction, lambdaChunkWorkMinutes: 5,
      cloudflareShape: "standard-1: 0.5 vCPU / 4 GiB / 8 GB disk; assumed busy CPU=0.2 vCPU" },
      workHours, residentHours,
      ephemeral: { ...ephemeral, usdPerWorkHour: ephemeral.usd / workHours },
      cloudRunRequest: { ...request, usdPerWorkHour: request.usd / workHours },
      cloudRunInstance: { ...instance, usdPerWorkHour: instance.usd / workHours },
      lambda: { ...lambda, compatibleUnsplit: busySeconds <= 900,
        invocationsAfterExplicitTaskRefactor: invocationCount, usdPerWorkHour: lambda.usd / workHours },
      cloudflare: { ...cloudflare, usdPerWorkHour: cloudflare.usd / workHours },
      fleets: [10, 1000].map(accounts => {
        const pool = poolCost({ ...poolAssumptions, residentHours: residentHours * accounts,
          peakConcurrent: Math.ceil(accounts * peakFraction) });
        return { accounts, pool, poolUsdPerAccount: pool.usd / accounts,
          poolUsdPerWorkHour: pool.usd / (accounts * workHours) };
      }),
    };
  }
  return { kind: "illustrative-cost-model-not-provider-benchmark", observedDate: "2026-10-18",
    currency: "USD", poolAssumptions, plans,
    accountLevelBaselines: { cloudflareWorkersPaidUsd: 5, poolOneHostUsd: 9.99 },
    excluded: ["AI", "durable Postgres", "durable files and backup operations", "network/IPv4",
      "shared account/API/auth services", "observability", "tax", "operations", "redundancy"],
    notes: ["No provider free allowances or commitments applied; allowances are shared, not per Matrix owner.",
      "Pool price uses CX33 live list rate but no available EU capacity at observation; not deployable supply guarantee.",
      "VPS creation lifetime <= one billing month; per-server cap does not cap repeated server creations.",
      "Peak fractions and target occupancy are assumptions, not observed concurrent load or queue guarantees.",
      "Cloud Run request estimate assumes durable queued work completes before response, and no idle compute.",
      "One minute covers all lifecycle overhead per activation/chunk hypothetically; replace with full-workload measurements.",
      "Cloudflare standard-1 is larger RAM but smaller CPU than other modeled runtimes; no throughput equivalence claimed.",
      "Lambda estimate requires explicit five-minute task decomposition, not preservation of terminals/processes."],
    sources: {
      hetznerBilling: "https://docs.hetzner.com/cloud/billing/faq/",
      hetznerRates: "https://docs.hetzner.cloud/reference/cloud#server-types-get-all-server-types",
      cloudRun: "https://cloud.google.com/run/pricing",
      lambda: "https://aws.amazon.com/lambda/pricing/",
      cloudflare: "https://developers.cloudflare.com/containers/platform/pricing/",
    } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(scenarios(), null, 2)}\n`);
}
