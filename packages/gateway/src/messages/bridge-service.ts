import {
  MESSAGING_BRIDGE_CHANGED_EVENT,
  MESSAGING_BRIDGE_NETWORKS,
  type MessagingBridgeChangedEvent,
  type MessagingBridgeConversation,
  type MessagingBridgeErrorCode,
  type MessagingBridgeLinkProgress,
  type MessagingBridgeLoginStep,
  type MessagingBridgeMessage,
  type MessagingBridgeNetwork,
  type MessagingBridgeStatus,
} from "@matrix-os/contracts/messaging-bridge";
import { errorName } from "./bridge-http.js";
import { BridgeLinkSessions, OwnerRateLimiter, type BridgeLinkSession } from "./bridge-link-sessions.js";
import type { BridgeMatrixClient } from "./bridge-matrix-client.js";
import { BridgePlatformError, type BridgePlatformFailure, type MessagingBridgePlatformClient } from "./bridge-platform-client.js";
import type { BridgeSessionProvider } from "./bridge-session.js";
import { InvalidBridgeCursorError, toBridgeMessage, type BridgeAccountRow, type MessagingBridgeStore } from "./bridge-store.js";
import type { BridgeSyncService } from "./bridge-sync.js";

/** Owner-facing bridge operations behind `/api/messages/bridge/*` (spec 2701). */

export const LINK_START_LIMIT = { limit: 5, windowMs: 10 * 60 * 1000 } as const;
export const SEND_LIMIT = { limit: 30, windowMs: 60 * 1000 } as const;
const IN_FLIGHT_SEND_CAP = 256;

export class MessagingBridgeServiceError extends Error {
  constructor(readonly code: MessagingBridgeErrorCode) {
    super(`Messaging bridge request failed (${code})`);
    this.name = "MessagingBridgeServiceError";
  }
}

const PLATFORM_FAILURE_CODES: Record<BridgePlatformFailure, MessagingBridgeErrorCode> = {
  not_enabled: "not_enabled",
  misconfigured: "misconfigured",
  unauthorized: "misconfigured",
  not_found: "not_found",
  invalid_request: "invalid_request",
  conflict: "conflict",
  rate_limited: "rate_limited",
  unavailable: "bridge_unavailable",
};

function serviceError(err: unknown): MessagingBridgeServiceError {
  if (err instanceof MessagingBridgeServiceError) return err;
  if (err instanceof BridgePlatformError) return new MessagingBridgeServiceError(PLATFORM_FAILURE_CODES[err.code]);
  if (err instanceof InvalidBridgeCursorError) return new MessagingBridgeServiceError("invalid_request");
  return new MessagingBridgeServiceError("bridge_unavailable");
}

type AccountState = MessagingBridgeStatus["networks"][number]["accounts"][number]["state"];

function accountState(status: BridgeAccountRow["status"]): AccountState {
  if (status === "connected" || status === "connecting") return status;
  if (status === "error") return "needs_relink";
  return "unknown";
}

export interface MessagingBridgeService {
  readonly ownerId: string;
  status(ownerId: string): Promise<MessagingBridgeStatus>;
  startLink(ownerId: string, network: MessagingBridgeNetwork, body: { flowId?: string }): Promise<MessagingBridgeLinkProgress>;
  submitLinkStep(
    ownerId: string,
    network: MessagingBridgeNetwork,
    linkId: string,
    body: { stepId: string; fields?: Record<string, string> },
  ): Promise<MessagingBridgeLinkProgress>;
  /** Best-effort and idempotent: abandons the owner's attempt locally and at the bridge. */
  cancelLink(ownerId: string, network: MessagingBridgeNetwork, linkId: string): Promise<void>;
  unlink(ownerId: string, network: MessagingBridgeNetwork, accountId: string): Promise<void>;
  listConversations(ownerId: string, query: { network?: MessagingBridgeNetwork; cursor?: string; limit: number }): Promise<{ items: MessagingBridgeConversation[]; nextCursor?: string }>;
  listMessages(ownerId: string, roomId: string, query: { cursor?: string; limit: number }): Promise<{ items: MessagingBridgeMessage[]; nextCursor?: string }>;
  send(ownerId: string, roomId: string, body: { body: string; clientTxnId: string }): Promise<MessagingBridgeMessage>;
  /** Delivery for an already-authorized 077 reply; not subject to the interactive send limit. */
  deliver(ownerId: string, roomId: string, body: { body: string; clientTxnId: string }): Promise<MessagingBridgeMessage>;
  /** Starts sync on boot when this owner already has a session and a linked account. */
  resume(): Promise<void>;
  sweep(): void;
  close(): Promise<void>;
}

export function createMessagingBridgeService(options: {
  ownerId: string;
  platform: MessagingBridgePlatformClient;
  store: MessagingBridgeStore;
  sessions: BridgeSessionProvider;
  matrix: BridgeMatrixClient;
  sync: BridgeSyncService;
  broadcast(ownerId: string, event: MessagingBridgeChangedEvent): void;
  now?: () => number;
}): MessagingBridgeService {
  const links = new BridgeLinkSessions(options.now, (dropped) => void cancelAtBridge(dropped));
  const linkLimiter = new OwnerRateLimiter(LINK_START_LIMIT.limit, LINK_START_LIMIT.windowMs, 1_024, options.now);
  const sendLimiter = new OwnerRateLimiter(SEND_LIMIT.limit, SEND_LIMIT.windowMs, 1_024, options.now);
  // Sends this process is currently delivering; capped so a stuck send cannot grow it unbounded.
  const inFlight = new Set<string>();

  function changed(ownerId: string, scope: MessagingBridgeChangedEvent["scope"], roomId?: string): void {
    options.broadcast(ownerId, {
      type: MESSAGING_BRIDGE_CHANGED_EVENT,
      scope,
      ...(roomId ? { roomId } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  /** Best-effort: the platform also cancels logins 10 minutes after their last step. */
  async function cancelAtBridge(link: BridgeLinkSession): Promise<void> {
    try {
      await options.platform.cancelLogin(link.network, { loginProcessId: link.loginProcessId });
    } catch (err: unknown) {
      console.warn("[messages/bridge-service] login cancel not confirmed", errorName(err));
    }
  }

  async function ensureSyncWhenLinked(ownerId: string): Promise<void> {
    if ((await options.store.listBridgeAccounts(ownerId)).length === 0) return;
    if (!await options.sessions.stored()) return;
    options.sync.ensureRunning();
  }

  async function completeLink(link: BridgeLinkSession, step: Extract<MessagingBridgeLoginStep, { type: "complete" }>): Promise<void> {
    await options.store.recordLinkedAccount({
      ownerId: link.ownerId,
      network: link.network,
      loginId: step.loginId,
      ...(step.displayName ? { displayName: step.displayName } : {}),
    });
    changed(link.ownerId, "accounts");
    try {
      await options.sessions.current();
      options.sync.ensureRunning();
    } catch (err: unknown) {
      // The account is recorded; status retries the session and starts sync later.
      console.warn("[messages/bridge-service] session unavailable after link", errorName(err));
    }
  }

  async function settle(link: BridgeLinkSession, step: MessagingBridgeLoginStep): Promise<MessagingBridgeLinkProgress> {
    if (step.type === "complete") {
      links.delete(link.linkId);
      await completeLink(link, step);
    } else if (step.type === "failed") {
      links.delete(link.linkId);
    } else {
      links.advance(link, step);
    }
    return { linkId: link.linkId, network: link.network, step };
  }

  /** Mirrors the bridge's logins for one network onto local accounts. */
  async function reconcile(
    ownerId: string,
    network: MessagingBridgeNetwork,
    logins: Awaited<ReturnType<MessagingBridgePlatformClient["listLogins"]>>,
  ): Promise<void> {
    const local = (await options.store.listBridgeAccounts(ownerId)).filter((account) => account.network === network);
    for (const login of logins) {
      // A login the bridge has but we never recorded (e.g. a crash right after linking).
      // `logins` may predate an unlink that finished since; a removed account stays removed.
      const accountId = local.find((account) => account.loginId === login.loginId)?.id
        ?? (await options.store.recordDiscoveredAccount({
          ownerId,
          network,
          loginId: login.loginId,
          ...(login.displayName ? { displayName: login.displayName } : {}),
        }))?.accountId;
      if (accountId && login.state !== "unknown") await options.store.setAccountHealth(ownerId, accountId, login.state);
    }
    for (const account of local) {
      if (!logins.some((login) => login.loginId === account.loginId)) {
        await options.store.setAccountHealth(ownerId, account.id, "needs_relink");
      }
    }
  }

  async function deliverInternal(ownerId: string, roomId: string, body: { body: string; clientTxnId: string }): Promise<MessagingBridgeMessage> {
    if (!await options.store.getConversationNetwork(ownerId, roomId)) throw new MessagingBridgeServiceError("not_found");
    const claimed = await options.store.claimOutgoing({ ownerId, roomId, clientTxnId: body.clientTxnId, body: body.body });
    const row = claimed.message;
    const key = `${ownerId}\u0000${body.clientTxnId}`;
    if (!claimed.created) {
      if (row.room_id !== roomId) throw new MessagingBridgeServiceError("conflict");
      // Already delivered, or being delivered right now by this process: never send twice.
      if (row.delivery === "sent" || (row.delivery === "sending" && inFlight.has(key))) return toBridgeMessage(row);
      if (row.delivery === "failed" && !await options.store.retryOutgoing(ownerId, body.clientTxnId)) {
        const current = await options.store.getOutgoing(ownerId, body.clientTxnId);
        if (!current) throw new MessagingBridgeServiceError("not_found");
        return current;
      }
    } else {
      changed(ownerId, "messages", roomId);
    }
    if (inFlight.size >= IN_FLIGHT_SEND_CAP) throw new MessagingBridgeServiceError("rate_limited");
    inFlight.add(key);
    let message: MessagingBridgeMessage;
    try {
      // The client transaction id is the Matrix transaction id: a retry is deduplicated by the homeserver.
      const sent = await options.sessions.withSession((session) => options.matrix.sendText(session, {
        roomId,
        txnId: body.clientTxnId,
        body: row.body,
      }));
      message = await options.store.markOutgoingSent(ownerId, body.clientTxnId, sent.eventId);
    } catch (err: unknown) {
      console.warn("[messages/bridge-service] send failed", errorName(err));
      message = await options.store.markOutgoingFailed(ownerId, body.clientTxnId);
    } finally {
      inFlight.delete(key);
    }
    changed(ownerId, "messages", roomId);
    changed(ownerId, "conversations");
    return message;
  }

  function guard<T>(operation: () => Promise<T>): Promise<T> {
    return operation().catch((err: unknown) => {
      const mapped = serviceError(err);
      if (mapped.code === "bridge_unavailable" || mapped.code === "misconfigured") {
        console.warn("[messages/bridge-service] request failed", errorName(err));
      }
      throw mapped;
    });
  }

  return {
    ownerId: options.ownerId,

    async status(ownerId) {
      let accounts = await options.store.listBridgeAccounts(ownerId);
      let networks: readonly MessagingBridgeNetwork[] = MESSAGING_BRIDGE_NETWORKS;
      let availability: MessagingBridgeStatus["availability"] = "ready";
      try {
        const session = await options.sessions.current();
        networks = session.networks;
        // Platform reads in parallel; owner-database writes one network at a time.
        const results = await Promise.allSettled(networks.map((network) => options.platform.listLogins(network)));
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled") await reconcile(ownerId, networks[index]!, result.value);
          else availability = "unavailable";
        }
        accounts = await options.store.listBridgeAccounts(ownerId);
        await ensureSyncWhenLinked(ownerId);
      } catch (err: unknown) {
        if (err instanceof BridgePlatformError && err.code === "not_enabled") {
          return { availability: "not_enabled", networks: [] };
        }
        console.warn("[messages/bridge-service] status degraded", errorName(err));
        availability = "unavailable";
      }
      if (options.sessions.tokenRejected() || options.sync.health() === "unavailable") availability = "unavailable";
      return {
        availability,
        networks: networks.map((network) => ({
          network,
          accounts: accounts
            .filter((account) => account.network === network)
            .slice(0, 16)
            .map((account) => ({
              accountId: account.id,
              ...(account.displayName ? { displayName: account.displayName.slice(0, 280) } : {}),
              state: accountState(account.status),
            })),
        })),
      };
    },

    startLink(ownerId, network, body) {
      return guard(async () => {
        if (!linkLimiter.take(ownerId)) throw new MessagingBridgeServiceError("rate_limited");
        // Only POST /session creates the owner's homeserver user, which the bridge login needs.
        await options.sessions.current();
        const progress = await options.platform.startLogin(network, body);
        const link = links.create(ownerId, network, progress.loginProcessId, progress.step);
        return settle(link, progress.step);
      });
    },

    submitLinkStep(ownerId, network, linkId, body) {
      return guard(async () => {
        const link = links.get(ownerId, linkId);
        if (link === "expired") return { linkId, network, step: { type: "failed", reason: "expired" } };
        if (!link || link.network !== network) throw new MessagingBridgeServiceError("not_found");
        if (link.busy || link.stepId !== body.stepId) throw new MessagingBridgeServiceError("conflict");
        link.busy = true;
        try {
          const progress = await options.platform.submitLoginStep(network, {
            loginProcessId: link.loginProcessId,
            stepId: body.stepId,
            ...(body.fields ? { fields: body.fields } : {}),
          }, { longPoll: link.stepType === "display_and_wait" });
          return await settle(link, progress.step);
        } catch (err: unknown) {
          if (err instanceof BridgePlatformError && err.code === "not_found") {
            links.delete(link.linkId);
            return { linkId, network, step: { type: "failed", reason: "expired" } };
          }
          throw err;
        } finally {
          link.busy = false;
        }
      });
    },

    async cancelLink(ownerId, network, linkId) {
      const link = links.get(ownerId, linkId);
      if (!link || link === "expired" || link.network !== network) return;
      links.delete(link.linkId);
      await cancelAtBridge(link);
    },

    unlink(ownerId, network, accountId) {
      return guard(async () => {
        const account = (await options.store.listBridgeAccounts(ownerId))
          .find((candidate) => candidate.id === accountId && candidate.network === network);
        if (!account) throw new MessagingBridgeServiceError("not_found");
        if (account.loginId) {
          try {
            await options.platform.logout(network, { loginId: account.loginId });
          } catch (err: unknown) {
            // Already gone at the bridge is the outcome we want; anything else keeps the account.
            if (!(err instanceof BridgePlatformError && err.code === "not_found")) throw err;
          }
        }
        await options.store.markAccountRemoved(ownerId, accountId);
        changed(ownerId, "accounts");
        if ((await options.store.listBridgeAccounts(ownerId)).length === 0) await options.sync.stop();
      });
    },

    listConversations: (ownerId, query) => guard(() => options.store.listConversations(ownerId, query)),

    listMessages(ownerId, roomId, query) {
      return guard(async () => {
        if (!await options.store.getConversationNetwork(ownerId, roomId)) throw new MessagingBridgeServiceError("not_found");
        if (query.cursor !== undefined) return options.store.listMessages(ownerId, roomId, query);
        const { page, markedRead } = await options.store.readLatestMessages(ownerId, roomId, query.limit);
        if (markedRead) changed(ownerId, "conversations");
        return page;
      });
    },

    send(ownerId, roomId, body) {
      return guard(async () => {
        if (!sendLimiter.take(ownerId)) throw new MessagingBridgeServiceError("rate_limited");
        return deliverInternal(ownerId, roomId, body);
      });
    },

    deliver: (ownerId, roomId, body) => guard(() => deliverInternal(ownerId, roomId, body)),

    async resume() {
      try {
        await ensureSyncWhenLinked(options.ownerId);
      } catch (err: unknown) {
        console.warn("[messages/bridge-service] sync resume failed", errorName(err));
      }
    },

    sweep() {
      links.sweep();
    },

    async close() {
      links.clear();
      linkLimiter.clear();
      sendLimiter.clear();
      await options.sync.stop();
    },
  };
}
