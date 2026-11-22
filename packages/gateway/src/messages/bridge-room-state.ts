import {
  MESSAGING_BRIDGE_MESSAGE_BODY_MAX,
  MatrixEventIdSchema,
  MessagingBridgeNetworkSchema,
  type MessagingBridgeNetwork,
} from "@matrix-os/contracts/messaging-bridge";

/**
 * Everything that interprets mautrix bridge conventions lives here, so a bridge
 * upgrade that changes them touches one file.
 *
 * Verified against mautrix bridgev2 (whatsapp, telegram, linkedin) conventions:
 *   - portal rooms carry `m.bridge` and the legacy `uk.half-shot.bridge` state
 *     events (MSC2346) whose `content.protocol.id` is the bridge network id;
 *   - per-login portals may name the owning login in `content.channel.receiver`;
 *   - bot and ghost localparts follow the bridge-host config
 *     (`<network>bot`, `<network>_<id>`);
 *   - messages relayed through double puppeting are sent as the owner's own
 *     Matrix user (and tagged `fi.mau.double_puppet_source`).
 */

export interface MatrixClientEvent {
  type: string;
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  state_key?: string;
  content?: Record<string, unknown>;
  unsigned?: { transaction_id?: string; redacted_because?: unknown; [key: string]: unknown };
}

export interface ClassifiedTimelineEvent {
  eventId: string;
  sender: string;
  direction: "incoming" | "outgoing";
  kind: "text" | "media" | "other";
  body: string;
  occurredAt: string;
  transactionId?: string;
}

const BRIDGE_STATE_TYPES = ["m.bridge", "uk.half-shot.bridge"] as const;
const BRIDGE_LOCALPART = /^(whatsapp|telegram|linkedin)(bot|_[a-z0-9._=\/+-]+)$/;
const BRIDGE_BOT_LOCALPART = /^(whatsapp|telegram|linkedin)bot$/;
const LOGIN_ID = /^[A-Za-z0-9._:=-]{1,128}$/;
const TEXT_MSGTYPES = new Set(["m.text", "m.notice", "m.emote"]);
const MEDIA_PLACEHOLDERS: Record<string, string> = {
  "m.image": "Photo",
  "m.video": "Video",
  "m.audio": "Audio message",
  "m.file": "File",
  "m.location": "Location",
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function splitUserId(userId: string): { localpart: string; server: string } | null {
  const match = /^@([^:]+):(.+)$/.exec(userId);
  return match ? { localpart: match[1]!, server: match[2]! } : null;
}

/** Portal network for a room, from the bridge state events in `stateEvents`. */
export function detectBridgeNetwork(
  stateEvents: readonly MatrixClientEvent[],
): { network: MessagingBridgeNetwork; receiver?: string } | null {
  for (const type of BRIDGE_STATE_TYPES) {
    for (const event of stateEvents) {
      if (event.type !== type || typeof event.state_key !== "string") continue;
      const protocol = record(record(event.content)?.protocol);
      const network = MessagingBridgeNetworkSchema.safeParse(protocol?.id);
      if (!network.success) continue;
      const receiver = record(record(event.content)?.channel)?.receiver;
      return typeof receiver === "string" && LOGIN_ID.test(receiver)
        ? { network: network.data, receiver }
        : { network: network.data };
    }
  }
  return null;
}

/** Bridge bots and ghosts on the bridge homeserver: the only accepted inviters. */
export function isBridgeNamespaceUser(userId: string, serverName: string): boolean {
  const parts = splitUserId(userId);
  return Boolean(parts && parts.server === serverName && BRIDGE_LOCALPART.test(parts.localpart));
}

export function isBridgeBotUser(userId: string): boolean {
  const parts = splitUserId(userId);
  return Boolean(parts && BRIDGE_BOT_LOCALPART.test(parts.localpart));
}

export function serverNameOf(userId: string): string | null {
  return splitUserId(userId)?.server ?? null;
}

export function memberDisplayNames(events: readonly MatrixClientEvent[]): Map<string, string> {
  // Bounded by the caller's event list (one sync batch or one room state).
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "m.room.member" || typeof event.state_key !== "string") continue;
    const displayname = record(event.content)?.displayname;
    if (typeof displayname === "string" && displayname.trim()) {
      names.set(event.state_key, displayname.trim().slice(0, 280));
    }
  }
  return names;
}

export function roomDisplayName(stateEvents: readonly MatrixClientEvent[], ownUserId: string): string {
  for (const event of stateEvents) {
    if (event.type !== "m.room.name" || event.state_key !== "") continue;
    const name = record(event.content)?.name;
    if (typeof name === "string" && name.trim()) return name.trim().slice(0, 280);
  }
  const others: string[] = [];
  for (const event of stateEvents) {
    if (event.type !== "m.room.member" || typeof event.state_key !== "string") continue;
    if (event.state_key === ownUserId || isBridgeBotUser(event.state_key)) continue;
    const content = record(event.content);
    if (content?.membership !== "join" && content?.membership !== "invite") continue;
    const displayname = content.displayname;
    if (typeof displayname === "string" && displayname.trim()) others.push(displayname.trim());
  }
  return others.length > 0 ? others.slice(0, 4).join(", ").slice(0, 280) : "Conversation";
}

function bodyFor(event: MatrixClientEvent, content: Record<string, unknown>): Pick<ClassifiedTimelineEvent, "kind" | "body"> | null {
  if (event.type === "m.sticker") return { kind: "media", body: "Sticker" };
  if (event.type === "m.room.encrypted") return { kind: "other", body: "Encrypted message" };
  if (event.type !== "m.room.message") return null;
  const msgtype = content.msgtype;
  if (typeof msgtype === "string" && TEXT_MSGTYPES.has(msgtype) && typeof content.body === "string") {
    return { kind: "text", body: content.body.slice(0, MESSAGING_BRIDGE_MESSAGE_BODY_MAX) };
  }
  if (typeof msgtype === "string" && Object.hasOwn(MEDIA_PLACEHOLDERS, msgtype)) {
    return { kind: "media", body: MEDIA_PLACEHOLDERS[msgtype]! };
  }
  return { kind: "other", body: "Unsupported message" };
}

/** A storable message for a timeline event, or null when the event is not a message. */
export function classifyTimelineEvent(event: MatrixClientEvent, ownUserId: string): ClassifiedTimelineEvent | null {
  if (typeof event.state_key === "string") return null;
  if (!event.event_id || !MatrixEventIdSchema.safeParse(event.event_id).success) return null;
  if (typeof event.sender !== "string" || typeof event.origin_server_ts !== "number") return null;
  if (event.unsigned?.redacted_because !== undefined) return null;
  const content = record(event.content) ?? {};
  if (record(content["m.relates_to"])?.rel_type === "m.replace") return null;
  const projected = bodyFor(event, content);
  if (!projected) return null;
  const occurred = new Date(event.origin_server_ts);
  if (Number.isNaN(occurred.getTime())) return null;
  const transactionId = event.unsigned?.transaction_id;
  return {
    eventId: event.event_id,
    sender: event.sender,
    direction: event.sender === ownUserId ? "outgoing" : "incoming",
    ...projected,
    occurredAt: occurred.toISOString(),
    ...(typeof transactionId === "string" && transactionId.length <= 128 ? { transactionId } : {}),
  };
}
