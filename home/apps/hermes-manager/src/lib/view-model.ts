import type { HermesChannel, HermesConfig, HermesStatus } from "./api";

export function readinessLabel(status: HermesStatus | null): string {
  if (!status) return "Loading";
  return status.readiness.replace(/_/g, " ");
}

export function readinessTone(readiness: string): string {
  if (readiness === "ready") return "ok";
  if (readiness === "installed" || readiness === "configuring" || readiness === "updating") return "warn";
  return "bad";
}

export function stepProgress(config: HermesConfig | null): { complete: number; total: number } {
  const steps = config?.setupSteps ?? [];
  return { complete: steps.filter((step) => step.status === "complete").length, total: steps.length };
}

export function channelById(channels: HermesChannel[], id: "telegram" | "whatsapp"): HermesChannel {
  return channels.find((channel) => channel.id === id) ?? {
    id,
    platform: id,
    enabled: false,
    configured: false,
    status: "disconnected",
    allowedSenderPolicy: "Not configured",
    updatedAt: "",
  };
}
