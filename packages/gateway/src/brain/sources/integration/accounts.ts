/**
 * Which integration accounts an owner has connected, for the Company Brain sources: the labels of the owner's active
 * connections of one service, read from the platform and never from a provider. The same two transports as the
 * caller (remote: GET {internalBaseUrl} with the machine bearer and signed owner delegation; local: the platform
 * database), chosen at construction; with neither, the owner has no account. One bounded read per lookup: a timeout,
 * a 256 KiB body, at most 500 connections. A failed lookup rejects with BrainIntegrationAccountsError (its cause
 * logged by name only), so a platform outage never reads as "not connected".
 */
import { boundedOperation } from "../../../bounded-operation.js";
import type { BrainIntegrationService } from "../../contracts.js";
import { discardBody, readBoundedJson } from "./bounded-body.js";
import {
  BRAIN_INTEGRATION_CONNECTIONS_MAX_BYTES, BRAIN_INTEGRATION_LABEL_PATTERN, BRAIN_INTEGRATION_OWNER_ID_PATTERN,
  BrainIntegrationConnectionsSchema, brainIntegrationTransport, brainRemoteIntegrationHeaders, findBrainPlatformUser,
  type BrainIntegrationCallerDeps,
} from "./caller.js";

export const BRAIN_INTEGRATION_ACCOUNTS_TIMEOUT_MS = 10_000;

export class BrainIntegrationAccountsError extends Error {
  constructor(options?: ErrorOptions) {
    super("Integration accounts unavailable", options);
    this.name = "BrainIntegrationAccountsError";
  }
}

export interface BrainIntegrationAccounts {
  /** Whether a transport exists (remote, or the platform database plus Pipedream); false: the kinds are not_configured. */
  configured(): boolean;
  /** False when no transport is configured or the owner has no active connection of the service. */
  isConnected(ownerId: string, service: BrainIntegrationService): Promise<boolean>;
  /** The owner's connection labels of the service, unique, in the platform's order. */
  accounts(ownerId: string, service: BrainIntegrationService): Promise<readonly string[]>;
}

export type BrainIntegrationAccountsDeps =
  Pick<BrainIntegrationCallerDeps, "internalBaseUrl" | "machineToken" | "db" | "pipedream" | "fetch" | "timeoutMs" | "env">;

function labelsOf(connections: readonly { readonly service: string; readonly account_label: string }[], service: string) {
  const labels = connections.filter((connection) => connection.service === service)
    .map((connection) => connection.account_label).filter((label) => BRAIN_INTEGRATION_LABEL_PATTERN.test(label));
  return [...new Set(labels)];
}

export function createBrainIntegrationAccounts(deps: BrainIntegrationAccountsDeps): BrainIntegrationAccounts {
  const transport = brainIntegrationTransport(deps);
  const timeoutMs = Math.min(Math.max(deps.timeoutMs ?? BRAIN_INTEGRATION_ACCOUNTS_TIMEOUT_MS, 1), 30_000);
  const fetcher = deps.fetch ?? fetch;

  async function remote(ownerId: string, service: string, signal: AbortSignal): Promise<readonly string[]> {
    const baseUrl = deps.internalBaseUrl!.replace(/\/+$/, "");
    const response = await fetcher(baseUrl, {
      headers: brainRemoteIntegrationHeaders(ownerId, deps.machineToken!), redirect: "error", signal,
    });
    if (!response.ok) {
      discardBody(response);
      throw new BrainIntegrationAccountsError({ cause: new Error(`status ${response.status}`) });
    }
    const body = await readBoundedJson(response, BRAIN_INTEGRATION_CONNECTIONS_MAX_BYTES, signal);
    const parsed = body.ok ? BrainIntegrationConnectionsSchema.safeParse(body.value) : null;
    if (parsed === null || !parsed.success) throw new BrainIntegrationAccountsError();
    return labelsOf(parsed.data, service);
  }

  async function local(ownerId: string, service: string): Promise<readonly string[]> {
    const user = await findBrainPlatformUser(deps.db!, ownerId, deps.env);
    return user === null ? [] : labelsOf(await deps.db!.listConnectedServices(user.id), service);
  }

  async function accounts(ownerId: string, service: BrainIntegrationService): Promise<readonly string[]> {
    if (transport === null || !BRAIN_INTEGRATION_OWNER_ID_PATTERN.test(ownerId)) return [];
    try {
      return await boundedOperation((signal) => transport === "remote"
        ? remote(ownerId, service, signal) : local(ownerId, service), timeoutMs);
    } catch (error: unknown) {
      console.warn(`[brain-integration] ${transport} ${service} accounts failed:`,
        error instanceof Error ? error.name : "UnknownError");
      throw error instanceof BrainIntegrationAccountsError ? error : new BrainIntegrationAccountsError({ cause: error });
    }
  }

  return {
    accounts,
    configured: () => transport !== null,
    async isConnected(ownerId, service) {
      return transport !== null && (await accounts(ownerId, service)).length > 0;
    },
  };
}
