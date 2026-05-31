import type { ConnectionState } from "@/hooks/useConnectionHealth";

export type GatewayReachability = "checking" | "online" | "unavailable";

export interface RuntimeStatus {
  reachability: GatewayReachability;
  releaseVersion?: string | null;
  releaseChannel?: string | null;
}

export interface ConnectionCopy {
  tone: "warn" | "danger";
  title: string;
  detail: string;
  action: string;
}

export function resolveConnectionCopy(state: ConnectionState, status: RuntimeStatus): ConnectionCopy {
  if (state === "disconnected") {
    return {
      tone: "danger",
      title: "Connection lost",
      detail: status.reachability === "online"
        ? "Your Matrix computer is online, but the live shell socket is closed."
        : "Your Matrix computer is not reachable yet. It may be restarting after an update.",
      action: "Reconnect",
    };
  }

  if (status.reachability === "online") {
    const version = status.releaseVersion ? ` ${status.releaseVersion}` : "";
    return {
      tone: "warn",
      title: "Reconnecting shell",
      detail: `The gateway is online${version}. Waiting for the live session to resume.`,
      action: "Retry now",
    };
  }

  if (status.reachability === "checking") {
    return {
      tone: "warn",
      title: "Checking Matrix computer",
      detail: "Matrix is checking whether your computer is restarting or applying an update.",
      action: "Retry now",
    };
  }

  return {
    tone: "warn",
    title: "Matrix computer is restarting",
    detail: "Services are coming back online. This usually happens during bundle upgrades or gateway restarts.",
    action: "Retry now",
  };
}
