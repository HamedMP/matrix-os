import {
  MESSAGING_BRIDGE_NETWORKS,
  MESSAGING_BRIDGE_NETWORK_LABELS,
  type MessagingBridgeConversation,
  type MessagingBridgeLoginStep,
  type MessagingBridgeMessage,
  type MessagingBridgeNetwork,
  type MessagingBridgeStatus,
} from "@matrix-os/contracts/messaging-bridge";

export type ChatAccount = MessagingBridgeStatus["networks"][number]["accounts"][number];
export type ChatAccountState = ChatAccount["state"];
export type ChatAppTone = "default" | "success" | "warning" | "error";

export interface ChatAppAccountRow {
  accountId: string;
  label: string;
  state: ChatAccountState;
  stateLabel: string;
  tone: ChatAppTone;
}

export interface ChatAppNetworkRow {
  network: MessagingBridgeNetwork;
  label: string;
  accounts: ChatAppAccountRow[];
  /** `null` when every account on this network is healthy or still connecting. */
  action: "connect" | "reconnect" | null;
}

export type ChatAppsSectionState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "not_enabled" }
  | { kind: "unavailable" }
  | { kind: "ready"; rows: ChatAppNetworkRow[]; hasAccounts: boolean };

const STATE_COPY: Record<ChatAccountState, { label: string; tone: ChatAppTone }> = {
  connected: { label: "Connected", tone: "success" },
  connecting: { label: "Connecting…", tone: "default" },
  needs_relink: { label: "Needs reconnecting", tone: "warning" },
  unknown: { label: "Status unknown", tone: "default" },
};

export function networkLabel(network: MessagingBridgeNetwork): string {
  return MESSAGING_BRIDGE_NETWORK_LABELS[network];
}

export function chatAccountLabel(network: MessagingBridgeNetwork, account: ChatAccount): string {
  const name = account.displayName?.trim();
  return name ? name : `${networkLabel(network)} account`;
}

export function deriveChatAppsSection(input: {
  status: MessagingBridgeStatus | null;
  loading: boolean;
  error: string | null;
}): ChatAppsSectionState {
  if (input.loading && !input.status) return { kind: "loading" };
  if (input.error) return { kind: "error", message: input.error };
  if (!input.status) return { kind: "loading" };
  if (input.status.availability === "not_enabled") return { kind: "not_enabled" };
  if (input.status.availability === "unavailable") return { kind: "unavailable" };
  const offered = new Map(input.status.networks.map((entry) => [entry.network, entry.accounts]));
  const rows = MESSAGING_BRIDGE_NETWORKS.filter((network) => offered.has(network)).map((network): ChatAppNetworkRow => {
    const accounts = (offered.get(network) ?? []).map((account) => ({
      accountId: account.accountId,
      label: chatAccountLabel(network, account),
      state: account.state,
      stateLabel: STATE_COPY[account.state].label,
      tone: STATE_COPY[account.state].tone,
    }));
    const action = accounts.length === 0 ? "connect" : accounts.some((a) => a.state === "needs_relink") ? "reconnect" : null;
    return { network, label: networkLabel(network), accounts, action };
  });
  return { kind: "ready", rows, hasAccounts: rows.some((row) => row.accounts.length > 0) };
}

/** WhatsApp and LinkedIn bridges are unofficial clients; the owner is told before linking. */
export function needsUnofficialWarning(network: MessagingBridgeNetwork): boolean {
  return network === "whatsapp" || network === "linkedin";
}

type FailureReason = Extract<MessagingBridgeLoginStep, { type: "failed" }>["reason"];

const FAILURE_COPY: Record<FailureReason, string> = {
  expired: "The link request expired. Try again.",
  rejected: "The app did not accept this link request. Check the details and try again.",
  bridge_unavailable: "Linking is unavailable right now. Try again in a few minutes.",
  unknown: "Linking did not finish. Try again.",
};

export function linkFailureMessage(reason: FailureReason): string {
  return FAILURE_COPY[reason];
}

export type ConversationFilter = MessagingBridgeNetwork | "all";

export function filterConversations(items: MessagingBridgeConversation[], filter: ConversationFilter): MessagingBridgeConversation[] {
  return filter === "all" ? items : items.filter((item) => item.network === filter);
}

function eventTime(value: string | undefined): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

/** Merges a refreshed page into loaded pages: newer data wins, newest activity first. */
export function mergeConversations(
  existing: MessagingBridgeConversation[],
  incoming: MessagingBridgeConversation[],
): MessagingBridgeConversation[] {
  const byRoom = new Map(existing.map((item) => [item.roomId, item]));
  for (const item of incoming) byRoom.set(item.roomId, item);
  const order = new Map([...existing, ...incoming].map((item, index) => [item.roomId, index]));
  return [...byRoom.values()].sort(
    (a, b) => eventTime(b.lastEventAt) - eventTime(a.lastEventAt) || (order.get(a.roomId) ?? 0) - (order.get(b.roomId) ?? 0),
  );
}

/**
 * Stable identity of a server message. Messages sent from Matrix carry a
 * `clientTxnId` through every delivery state (the `eventId` only arrives once
 * delivered); messages from the other app carry only an `eventId`.
 */
export function messageKey(message: MessagingBridgeMessage): string {
  return message.clientTxnId ? `txn:${message.clientTxnId}` : `event:${message.eventId ?? ""}`;
}

/** Oldest first, deduplicated by identity; later copies win so delivery updates apply. */
export function mergeMessages(existing: MessagingBridgeMessage[], incoming: MessagingBridgeMessage[]): MessagingBridgeMessage[] {
  const byKey = new Map<string, MessagingBridgeMessage>();
  for (const item of [...existing, ...incoming]) byKey.set(messageKey(item), item);
  return [...byKey.values()].sort((a, b) => eventTime(a.occurredAt) - eventTime(b.occurredAt));
}

export interface PendingSend {
  clientTxnId: string;
  body: string;
  state: "sending" | "failed";
  createdAt: string;
}

export type ThreadEntry =
  | { kind: "message"; key: string; message: MessagingBridgeMessage }
  | { kind: "pending"; key: string; pending: PendingSend };

/**
 * Server messages plus local sends. A local send yields to the server copy
 * once the server has it, except while the owner retries a send the server
 * recorded as failed: then the local retry state is shown instead.
 */
export function deriveThreadEntries(serverMessages: MessagingBridgeMessage[], pending: PendingSend[]): ThreadEntry[] {
  const pendingIds = new Set(pending.map((item) => item.clientTxnId));
  const serverDelivery = new Map(
    serverMessages.filter((item) => item.clientTxnId).map((item) => [item.clientTxnId as string, item.delivery]),
  );
  return [
    ...serverMessages
      .filter((item) => !(item.clientTxnId && item.delivery === "failed" && pendingIds.has(item.clientTxnId)))
      .map((item): ThreadEntry => ({ kind: "message", key: messageKey(item), message: item })),
    ...pending
      .filter((item) => !serverDelivery.has(item.clientTxnId) || serverDelivery.get(item.clientTxnId) === "failed")
      .map((item): ThreadEntry => ({ kind: "pending", key: `txn:${item.clientTxnId}`, pending: item })),
  ];
}

/** A server message the owner can retry: sent from Matrix and recorded as failed. */
export function retryableFailure(message: MessagingBridgeMessage): PendingSend | null {
  if (message.direction !== "outgoing" || message.delivery !== "failed" || !message.clientTxnId) return null;
  return { clientTxnId: message.clientTxnId, body: message.body, state: "failed", createdAt: message.occurredAt };
}

export interface ThreadBubbleView {
  outgoing: boolean;
  /** Shown above incoming messages only. */
  sender: string | null;
  body: string;
  /** Media and unsupported events carry a placeholder body, shown in italics. */
  placeholder: boolean;
  time: string;
  /** Delivery state, shown for outgoing messages only. */
  delivery: PendingSend["state"] | "sent" | null;
  retry: PendingSend | null;
}

export function threadBubbleView(entry: ThreadEntry): ThreadBubbleView {
  if (entry.kind === "pending") {
    const { pending } = entry;
    return { outgoing: true, sender: null, body: pending.body, placeholder: false, time: pending.createdAt, delivery: pending.state, retry: pending.state === "failed" ? pending : null };
  }
  const { message } = entry;
  const outgoing = message.direction === "outgoing";
  return {
    outgoing,
    sender: outgoing ? null : message.senderName,
    body: message.body,
    placeholder: message.kind !== "text",
    time: message.occurredAt,
    delivery: outgoing ? (message.delivery ?? null) : null,
    retry: retryableFailure(message),
  };
}

/** Valid Matrix transaction id per the send contract: 8-64 of [A-Za-z0-9_-]. */
export function createClientTxnId(): string {
  return `m${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
}

export function formatMessageTime(value: string | undefined, now: Date = new Date()): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
