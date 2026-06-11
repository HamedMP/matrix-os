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
        : "The gateway is not answering yet. Matrix will keep retrying in the background.",
      action: "Reconnect",
    };
  }

  if (status.reachability === "online") {
    return {
      tone: "warn",
      title: "Reconnecting shell",
      detail: "The gateway is online. Waiting for the live session to resume.",
      action: "Retry now",
    };
  }

  if (status.reachability === "checking") {
    return {
      tone: "warn",
      title: "Checking connection",
      detail: "Matrix is checking the gateway and live shell session.",
      action: "Retry now",
    };
  }

  return {
    tone: "warn",
    title: "Matrix is reconnecting",
    detail: "The gateway did not answer yet. Matrix is keeping your workspace open while services settle.",
    action: "Retry now",
  };
}
