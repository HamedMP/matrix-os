import {
  OWNED_MACHINE_LIMIT_PER_ACCOUNT,
  OwnedComputerListResponseSchema,
  OwnedComputerSummarySchema,
  OwnedComputerUpdateRequestSchema,
  type OwnedComputerStatus,
  type OwnedComputerSummary,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

export const OWNED_COMPUTERS_PATH = "/api/auth/owned-computers";
export const OWNED_COMPUTER_INSTALL_COMMAND =
  "curl -fsSL https://get.matrix-os.com/install | sudo bash -s -- --connect";

/** Transport supplied by each surface (Web fetch, Electron trusted-core client). */
export interface OwnedComputersTransport {
  /** `init.signal` aborts a list load the panel no longer needs (unmount or a newer load). */
  get(path: string, init?: { signal?: AbortSignal }): Promise<unknown>;
  patch(path: string, body: unknown): Promise<unknown>;
  remove(path: string): Promise<void>;
}

export interface OwnedComputerList {
  computers: OwnedComputerSummary[];
  limit: number;
}

export type OwnedComputerUpdate = z.infer<typeof OwnedComputerUpdateRequestSchema>;
export type OwnedComputersFailure = "load" | "rename" | "update" | "remove";

/** Fixed copy only: server error strings are never shown. */
export const OWNED_COMPUTERS_FAILURE_COPY: Record<OwnedComputersFailure, string> = {
  load: "Your computers could not be loaded. Nothing was changed.",
  rename: "The name could not be saved. Try again.",
  update: "The setting could not be saved. Try again.",
  remove: "The computer could not be removed. It is still connected.",
};

const MachineIdSchema = z.string().uuid();

function computerPath(machineId: string): string {
  return `${OWNED_COMPUTERS_PATH}/${encodeURIComponent(MachineIdSchema.parse(machineId))}`;
}

export function createOwnedComputersClient(transport: OwnedComputersTransport) {
  return {
    async list(init?: { signal?: AbortSignal }): Promise<OwnedComputerList> {
      const parsed = OwnedComputerListResponseSchema.parse(await transport.get(OWNED_COMPUTERS_PATH, init));
      return { computers: parsed.computers, limit: parsed.limit };
    },
    async update(machineId: string, patch: OwnedComputerUpdate): Promise<OwnedComputerSummary> {
      const body = OwnedComputerUpdateRequestSchema.parse(patch);
      return OwnedComputerSummarySchema.parse(await transport.patch(computerPath(machineId), body));
    },
    async remove(machineId: string): Promise<void> {
      await transport.remove(computerPath(machineId));
    },
  };
}

export function ownedComputerStatusLabel(status: OwnedComputerStatus): string {
  if (status === "online") return "Online";
  if (status === "offline") return "Offline";
  return "Connecting";
}

export function ownedComputerLastSeenLabel(lastSeenAt: string | null, now: Date): string {
  if (!lastSeenAt) return "Not connected yet";
  const seen = Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return "Not connected yet";
  const minutes = Math.floor(Math.max(0, now.getTime() - seen) / 60_000);
  if (minutes < 1) return "Last seen just now";
  if (minutes < 60) return `Last seen ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last seen ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `Last seen ${days} ${days === 1 ? "day" : "days"} ago`;
}

export function ownedComputerPlatformLabel(computer: OwnedComputerSummary): string {
  const parts = [computer.os, computer.arch, computer.agentVersion ? `v${computer.agentVersion.replace(/^v/, "")}` : null];
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

export function ownedComputersAtLimit(list: OwnedComputerList): boolean {
  return list.computers.length >= Math.min(list.limit, OWNED_MACHINE_LIMIT_PER_ACCOUNT);
}

export function replaceOwnedComputer(list: OwnedComputerList, next: OwnedComputerSummary): OwnedComputerList {
  return { ...list, computers: list.computers.map((computer) => (computer.machineId === next.machineId ? next : computer)) };
}

export function withoutOwnedComputer(list: OwnedComputerList, machineId: string): OwnedComputerList {
  return { ...list, computers: list.computers.filter((computer) => computer.machineId !== machineId) };
}

export type OwnedComputersAvailability = "manage" | "hosted-account";

/**
 * Hosted shells and computers enrolled through the platform (substrate
 * "owned") manage owned computers with the signed-in account. A standalone
 * self-hosted install has no Matrix account session, so it points there.
 */
export function ownedComputersAvailability(runtime: { selfHosted: boolean; substrate: string | null }): OwnedComputersAvailability {
  if (!runtime.selfHosted || runtime.substrate === "owned") return "manage";
  return "hosted-account";
}
