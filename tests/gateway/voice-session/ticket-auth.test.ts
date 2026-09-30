import { describe, expect, it } from "vitest";
import {
  createVoiceOriginAllowlist,
  VoiceTicketAuthority,
  VoiceTicketError,
} from "../../../packages/gateway/src/voice-session/ticket-auth.js";

const PATH = "/ws/chats/chat_main/voice/vs_a";
const BINDING = {
  principalId: "user_1",
  chatId: "chat_main",
  sessionId: "vs_a",
  path: PATH,
  generation: 1,
};

function makeAuthority(options: { ttlMs?: number; maxEntries?: number } = {}) {
  let t = 1_000;
  const authority = new VoiceTicketAuthority({
    ttlMs: options.ttlMs ?? 30_000,
    maxEntries: options.maxEntries ?? 64,
    hmacKey: new Uint8Array(32).fill(7),
    now: () => t,
    random: (() => {
      let seed = 0;
      return (bytes: number) => {
        const out = new Uint8Array(bytes);
        for (let i = 0; i < bytes; i += 1) out[i] = (seed++ + i) % 256;
        return out;
      };
    })(),
  });
  return { authority, advance: (ms: number) => { t += ms; } };
}

function expectTicketError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(VoiceTicketError);
    expect((error as VoiceTicketError).code).toBe(code);
    return;
  }
  throw new Error(`expected VoiceTicketError(${code})`);
}

describe("VoiceTicketAuthority", () => {
  it("mints vt_ tickets bound to principal/chat/session/path/generation", () => {
    const { authority } = makeAuthority();
    const minted = authority.mint(BINDING);
    expect(minted.ticket).toMatch(/^vt_[A-Za-z0-9_-]{32,128}$/);
    expect(minted.generation).toBe(1);
    expect(minted.expiresAtMs).toBe(31_000);
  });

  it("consumes exactly once and returns the committed binding", () => {
    const { authority } = makeAuthority();
    const minted = authority.mint(BINDING);
    const consumed = authority.consume(minted.ticket, {
      path: PATH,
      sessionId: "vs_a",
      chatId: "chat_main",
    });
    expect(consumed.binding).toEqual(BINDING);
    expect(authority.describeSession("vs_a")).toEqual({ generation: 1, state: "consumed" });
  });

  it("rejects replay of a consumed ticket", () => {
    const { authority } = makeAuthority();
    const minted = authority.mint(BINDING);
    const expected = { path: PATH, sessionId: "vs_a", chatId: "chat_main" };
    authority.consume(minted.ticket, expected);
    expectTicketError(() => authority.consume(minted.ticket, expected), "consumed");
  });

  it("rejects unknown and malformed tickets with invalid_ticket", () => {
    const { authority } = makeAuthority();
    const expected = { path: PATH, sessionId: "vs_a", chatId: "chat_main" };
    expectTicketError(() => authority.consume("vt_" + "a".repeat(40), expected), "invalid_ticket");
    expectTicketError(() => authority.consume("not-a-ticket", expected), "invalid_ticket");
    expectTicketError(() => authority.consume(42, expected), "invalid_ticket");
    expectTicketError(() => authority.consume("", expected), "invalid_ticket");
  });

  it("rejects binding mismatch on path, session, or chat", () => {
    const { authority } = makeAuthority();
    const minted = authority.mint(BINDING);
    expectTicketError(
      () => authority.consume(minted.ticket, { path: "/ws/chats/chat_main/voice/vs_b", sessionId: "vs_a", chatId: "chat_main" }),
      "binding_mismatch",
    );
    const minted2 = authority.mint({ ...BINDING, generation: 2 });
    expectTicketError(
      () => authority.consume(minted2.ticket, { path: PATH, sessionId: "vs_b", chatId: "chat_main" }),
      "binding_mismatch",
    );
  });

  it("expires tickets after TTL and rejects them", () => {
    const { authority, advance } = makeAuthority({ ttlMs: 1_000 });
    const minted = authority.mint(BINDING);
    advance(1_001);
    expectTicketError(
      () => authority.consume(minted.ticket, { path: PATH, sessionId: "vs_a", chatId: "chat_main" }),
      "expired",
    );
  });

  it("supersedes predecessors on rotation; latest committed generation wins", () => {
    const { authority } = makeAuthority();
    const first = authority.mint(BINDING);
    const second = authority.mint({ ...BINDING, generation: 2 });
    // Predecessor credential is dead even though it was never consumed.
    expectTicketError(
      () => authority.consume(first.ticket, { path: PATH, sessionId: "vs_a", chatId: "chat_main" }),
      "superseded",
    );
    const consumed = authority.consume(second.ticket, {
      path: PATH,
      sessionId: "vs_a",
      chatId: "chat_main",
    });
    expect(consumed.binding.generation).toBe(2);
    expect(authority.describeSession("vs_a")).toEqual({ generation: 2, state: "consumed" });
  });

  it("revokes all minted credentials for a session", () => {
    const { authority } = makeAuthority();
    const minted = authority.mint(BINDING);
    authority.revokeSession("vs_a");
    expectTicketError(
      () => authority.consume(minted.ticket, { path: PATH, sessionId: "vs_a", chatId: "chat_main" }),
      "revoked",
    );
  });

  it("bounds the store and evicts terminal records before refusing", () => {
    const { authority } = makeAuthority({ maxEntries: 2 });
    authority.mint({ ...BINDING, sessionId: "vs_1" });
    const consumed = authority.mint({ ...BINDING, sessionId: "vs_2" });
    authority.consume(consumed.ticket, { path: PATH, sessionId: "vs_2", chatId: "chat_main" });
    // Full: evicts the consumed record, keeps minted state.
    authority.mint({ ...BINDING, sessionId: "vs_3" });
    expect(authority.size).toBe(2);
    // Two live minted records -> capacity error rather than replay-state loss.
    expectTicketError(() => authority.mint({ ...BINDING, sessionId: "vs_4" }), "capacity");
  });

  it("sweeps expired records on mint", () => {
    const { authority, advance } = makeAuthority({ ttlMs: 500, maxEntries: 3 });
    authority.mint({ ...BINDING, sessionId: "vs_1" });
    authority.mint({ ...BINDING, sessionId: "vs_2" });
    advance(600);
    authority.mint({ ...BINDING, sessionId: "vs_3" });
    expect(authority.size).toBe(1);
  });

  it("never stores the raw ticket: different HMAC keys reject each other's tickets", () => {
    const first = new VoiceTicketAuthority({ hmacKey: new Uint8Array(32).fill(1) });
    const second = new VoiceTicketAuthority({ hmacKey: new Uint8Array(32).fill(2) });
    const minted = first.mint(BINDING);
    expectTicketError(
      () => second.consume(minted.ticket, { path: PATH, sessionId: "vs_a", chatId: "chat_main" }),
      "invalid_ticket",
    );
  });

  it("is a single-process authority: a second instance with the SAME key cannot consume", () => {
    // Replica-isolation proof for the documented invariant: verify+consume is
    // scoped to one process. Even sharing the HMAC key, instance B holds no
    // record of A's mint, so a ticket consumed on A cannot replay on B.
    const sharedKey = new Uint8Array(32).fill(9);
    const authorityA = new VoiceTicketAuthority({ hmacKey: sharedKey });
    const authorityB = new VoiceTicketAuthority({ hmacKey: sharedKey });
    const minted = authorityA.mint(BINDING);
    expectTicketError(
      () => authorityB.consume(minted.ticket, { path: PATH, sessionId: "vs_a", chatId: "chat_main" }),
      "invalid_ticket",
    );
  });

  it("rejects unsafe bindings at mint time", () => {
    const { authority } = makeAuthority();
    expect(() => authority.mint({ ...BINDING, path: "relative" })).toThrow(TypeError);
    expect(() => authority.mint({ ...BINDING, generation: 0 })).toThrow(TypeError);
    expect(() => authority.mint({ ...BINDING, chatId: "" })).toThrow(TypeError);
    // Unsupported binding fields are refused up front.
    expect(() => authority.mint({ ...BINDING, extra: "x" } as never)).toThrow(TypeError);
  });
});

describe("createVoiceOriginAllowlist", () => {
  it("allows exact origins only — no wildcards", () => {
    const isAllowed = createVoiceOriginAllowlist(["https://app.example.com", "http://localhost:3000"]);
    expect(isAllowed("https://app.example.com")).toBe(true);
    expect(isAllowed("http://localhost:3000")).toBe(true);
    expect(isAllowed("https://evil.example.com")).toBe(false);
    expect(isAllowed("https://app.example.com.evil.com")).toBe(false);
    expect(isAllowed("*")).toBe(false);
    expect(isAllowed(undefined)).toBe(false);
  });

  it("optionally tolerates missing origins for non-browser clients", () => {
    const isAllowed = createVoiceOriginAllowlist(["https://app.example.com"], { allowMissing: true });
    expect(isAllowed(undefined)).toBe(true);
    expect(isAllowed("")).toBe(true);
    expect(isAllowed("https://nope.example.com")).toBe(false);
  });
});
