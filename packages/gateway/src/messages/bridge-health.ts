import type { MessagingNetworkSlug } from "./schemas.js";
import type { MessagingRepository, MessagingOwnerScope } from "./repository.js";
import { MessagingError } from "./errors.js";

export type MessagingHealthStatus = "ok" | "degraded" | "down" | "unknown";
export type MessagingRecoveryAction = "recheck" | "restart_bridge" | "relink";

export interface MessagingNetworkHealth {
  network: MessagingNetworkSlug;
  status: MessagingHealthStatus;
  accountsHealthy: number;
  accountsNeedingRelink: number;
}

export interface MessagingHealthSummary {
  homeserver: MessagingHealthStatus;
  networks: MessagingNetworkHealth[];
}

export interface MessagingRecoveryResult {
  accountId: string;
  status: "recovery_started";
}

export interface MessagingBridgeHealthService {
  getHealth(scope: MessagingOwnerScope): Promise<MessagingHealthSummary>;
  startRecovery(input: MessagingOwnerScope & { accountId: string; action: MessagingRecoveryAction }): Promise<MessagingRecoveryResult>;
}

export function createMessagingBridgeHealthService(repository: MessagingRepository): MessagingBridgeHealthService {
  return {
    async getHealth(scope) {
      const accounts = await repository.listAccounts(scope);
      const networks: MessagingNetworkHealth[] = (["telegram", "whatsapp"] as const).map((network) => {
        const networkAccounts = accounts.filter((account) => account.networkSlug === network);
        const accountsHealthy = networkAccounts.filter((account) => account.status === "connected").length;
        const accountsNeedingRelink = networkAccounts.filter((account) => account.status === "error" || account.status === "disconnected").length;
        return {
          network,
          status: accountsNeedingRelink > 0 ? "degraded" : "ok",
          accountsHealthy,
          accountsNeedingRelink,
        };
      });
      return { homeserver: "ok", networks };
    },
    async startRecovery(input) {
      const account = await repository.getAccount({ ownerId: input.ownerId }, input.accountId);
      if (!account) {
        throw new MessagingError("not_found", "account not found", 404);
      }
      return { accountId: input.accountId, status: "recovery_started" };
    },
  };
}
