import { describe, expect, it } from "vitest";
import {
  classifyTimelineEvent,
  detectBridgeNetwork,
  isBridgeBotUser,
  isBridgeNamespaceUser,
  memberDisplayNames,
  roomDisplayName,
  type MatrixClientEvent,
} from "../../../packages/gateway/src/messages/bridge-room-state.js";

const self = "@mx_owner:bridge.example.test";
const server = "bridge.example.test";

function bridgeState(type: string, protocolId: string, extra: Record<string, unknown> = {}): MatrixClientEvent {
  return {
    type,
    state_key: `net.example://${protocolId}/abc`,
    sender: `@${protocolId}bot:${server}`,
    content: { bridgebot: `@${protocolId}bot:${server}`, protocol: { id: protocolId, displayname: protocolId }, channel: { id: "abc", ...extra } },
  };
}

function message(content: Record<string, unknown>, overrides: Partial<MatrixClientEvent> = {}): MatrixClientEvent {
  return {
    type: "m.room.message",
    event_id: "$evt1",
    sender: "@whatsapp_4915550001:bridge.example.test",
    origin_server_ts: Date.parse("2026-11-22T10:00:00.000Z"),
    content,
    ...overrides,
  };
}

describe("bridge room network detection", () => {
  it("labels portal rooms from the m.bridge or legacy half-shot state protocol id", () => {
    expect(detectBridgeNetwork([bridgeState("m.bridge", "whatsapp")])).toEqual({ network: "whatsapp" });
    expect(detectBridgeNetwork([bridgeState("uk.half-shot.bridge", "telegram")])).toEqual({ network: "telegram" });
    expect(detectBridgeNetwork([bridgeState("m.bridge", "linkedin", { receiver: "login_9" })])).toEqual({ network: "linkedin", receiver: "login_9" });
  });

  it("ignores rooms without bridge state, with an unknown protocol, or with malformed content", () => {
    expect(detectBridgeNetwork([])).toBeNull();
    expect(detectBridgeNetwork([{ type: "m.room.name", state_key: "", content: { name: "WhatsApp bridge bot" } }])).toBeNull();
    expect(detectBridgeNetwork([bridgeState("m.bridge", "signal")])).toBeNull();
    expect(detectBridgeNetwork([{ type: "m.bridge", state_key: "x", content: { protocol: "whatsapp" } }])).toBeNull();
    expect(detectBridgeNetwork([{ type: "m.bridge", content: { protocol: { id: "whatsapp" } } }])).toBeNull();
  });

  it("recognizes bridge bots and ghosts only on the bridge homeserver", () => {
    expect(isBridgeNamespaceUser("@whatsappbot:bridge.example.test", server)).toBe(true);
    expect(isBridgeNamespaceUser("@telegram_12345:bridge.example.test", server)).toBe(true);
    expect(isBridgeNamespaceUser("@linkedin_abc:bridge.example.test", server)).toBe(true);
    expect(isBridgeNamespaceUser("@whatsappbot:evil.example", server)).toBe(false);
    expect(isBridgeNamespaceUser("@alice:bridge.example.test", server)).toBe(false);
    expect(isBridgeBotUser("@telegrambot:bridge.example.test")).toBe(true);
    expect(isBridgeBotUser("@telegram_1:bridge.example.test")).toBe(false);
  });
});

describe("bridge room labels", () => {
  it("prefers the room name, then other members, never the owner or bridge bot", () => {
    const members: MatrixClientEvent[] = [
      { type: "m.room.member", state_key: self, content: { membership: "join", displayname: "Owner" } },
      { type: "m.room.member", state_key: "@whatsappbot:bridge.example.test", content: { membership: "join", displayname: "WhatsApp bridge bot" } },
      { type: "m.room.member", state_key: "@whatsapp_1:bridge.example.test", content: { membership: "join", displayname: "Sara" } },
    ];
    expect(roomDisplayName([...members, { type: "m.room.name", state_key: "", content: { name: "Family" } }], self)).toBe("Family");
    expect(roomDisplayName(members, self)).toBe("Sara");
    expect(roomDisplayName([], self)).toBe("Conversation");
    expect(memberDisplayNames(members).get("@whatsapp_1:bridge.example.test")).toBe("Sara");
  });
});

describe("timeline event classification", () => {
  it("keeps text, marks the owner's own messages outgoing, and keeps the transaction id", () => {
    expect(classifyTimelineEvent(message({ msgtype: "m.text", body: "hi" }), self)).toEqual({
      eventId: "$evt1",
      sender: "@whatsapp_4915550001:bridge.example.test",
      direction: "incoming",
      kind: "text",
      body: "hi",
      occurredAt: "2026-11-22T10:00:00.000Z",
    });
    const own = classifyTimelineEvent(message({ msgtype: "m.text", body: "typed on phone", "fi.mau.double_puppet_source": "mautrix-whatsapp" }, { sender: self }), self);
    expect(own).toMatchObject({ direction: "outgoing", kind: "text", body: "typed on phone" });
    const echo = classifyTimelineEvent(message({ msgtype: "m.text", body: "sent from Matrix" }, { sender: self, unsigned: { transaction_id: "txn_12345678" } }), self);
    expect(echo).toMatchObject({ direction: "outgoing", transactionId: "txn_12345678" });
  });

  it("projects media and unsupported events onto fixed placeholders", () => {
    expect(classifyTimelineEvent(message({ msgtype: "m.image", body: "IMG_0001.jpg", url: "mxc://x/y" }), self)).toMatchObject({ kind: "media", body: "Photo" });
    expect(classifyTimelineEvent(message({ msgtype: "m.file", body: "secret-plans.pdf" }), self)).toMatchObject({ kind: "media", body: "File" });
    expect(classifyTimelineEvent({ ...message({ body: "sticker" }), type: "m.sticker" }, self)).toMatchObject({ kind: "media", body: "Sticker" });
    expect(classifyTimelineEvent({ ...message({ ciphertext: "..." }), type: "m.room.encrypted" }, self)).toMatchObject({ kind: "other", body: "Encrypted message" });
    expect(classifyTimelineEvent(message({ msgtype: "org.example.poll", body: "vote" }), self)).toMatchObject({ kind: "other", body: "Unsupported message" });
    for (const inherited of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(classifyTimelineEvent(message({ msgtype: inherited, body: "x" }), self), inherited).toMatchObject({ kind: "other", body: "Unsupported message" });
    }
  });

  it("drops state, reactions, edits, redactions and malformed events", () => {
    expect(classifyTimelineEvent({ ...message({ membership: "join" }), type: "m.room.member", state_key: self }, self)).toBeNull();
    expect(classifyTimelineEvent({ ...message({}), type: "m.reaction" }, self)).toBeNull();
    expect(classifyTimelineEvent(message({ msgtype: "m.text", body: "* fixed", "m.relates_to": { rel_type: "m.replace", event_id: "$a" } }), self)).toBeNull();
    expect(classifyTimelineEvent(message({}, { unsigned: { redacted_because: {} } }), self)).toBeNull();
    expect(classifyTimelineEvent(message({ msgtype: "m.text", body: "x" }, { event_id: undefined }), self)).toBeNull();
    expect(classifyTimelineEvent(message({ msgtype: "m.text", body: "x" }, { event_id: "not-an-event-id" }), self)).toBeNull();
  });

  it("truncates bodies to the contract maximum", () => {
    const long = "x".repeat(20_000);
    const classified = classifyTimelineEvent(message({ msgtype: "m.text", body: long }), self);
    expect(classified?.body).toHaveLength(16_000);
  });
});
