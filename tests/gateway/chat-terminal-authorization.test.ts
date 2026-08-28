import { describe, expect, it, vi } from "vitest";
import {
  authorizeChatTerminalAttach,
  authorizeStandaloneTerminalAttach,
} from "../../packages/gateway/src/chat/terminal-authorization.js";

const owner = { type: "personal" as const, ownerId: "user_a" };

describe("Chat terminal attach authorization", () => {
  it("allows standalone attachment only when the owner has no Chat binding", async () => {
    const listBoundTerminalSessionIds = vi.fn(async (_owner, sessionIds: readonly string[]) => (
      sessionIds.filter((sessionId) => sessionId === "terminal_bound")
    ));

    await expect(authorizeStandaloneTerminalAttach({
      repository: { listBoundTerminalSessionIds },
      owner,
      sessionId: "terminal_manual",
    })).resolves.toBe(true);
    await expect(authorizeStandaloneTerminalAttach({
      repository: { listBoundTerminalSessionIds },
      owner,
      sessionId: "terminal_bound",
    })).resolves.toBe(false);

    expect(listBoundTerminalSessionIds).toHaveBeenNthCalledWith(1, owner, ["terminal_manual"]);
    expect(listBoundTerminalSessionIds).toHaveBeenNthCalledWith(2, owner, ["terminal_bound"]);
  });

  it("fails standalone attachment closed on invalid identifiers and dependency errors", async () => {
    await expect(authorizeStandaloneTerminalAttach({
      repository: {
        listBoundTerminalSessionIds: vi.fn(async () => { throw new Error("private database failure"); }),
      },
      owner,
      sessionId: "terminal_manual",
    })).resolves.toBe(false);
    await expect(authorizeStandaloneTerminalAttach({
      repository: { listBoundTerminalSessionIds: vi.fn(async () => []) },
      owner,
      sessionId: "not a valid session",
    })).resolves.toBe(false);
  });

  it("requires an exact persisted binding and a live attachable session", async () => {
    const getTerminalBinding = vi.fn(async () => ({
      sessionCreatedAt: "2026-08-28T10:00:00.000Z",
    }));
    const get = vi.fn(async () => ({
      name: "terminal_bound",
      status: "active",
      recoverable: false,
      createdAt: "2026-08-28T10:00:00.000Z",
      incarnationVerified: true,
    }));

    await expect(authorizeChatTerminalAttach({
      repository: { getTerminalBinding },
      registry: { get },
      owner,
      chatId: "chat_selected",
      sessionId: "terminal_bound",
    })).resolves.toBe(true);
    expect(getTerminalBinding).toHaveBeenCalledWith(owner, "chat_selected", "terminal_bound");
    expect(get).toHaveBeenCalledWith("terminal_bound");
  });

  it("rejects foreign or unbound Chat sessions before the live lookup", async () => {
    const get = vi.fn();

    await expect(authorizeChatTerminalAttach({
      repository: { getTerminalBinding: vi.fn(async () => null) },
      registry: { get },
      owner,
      chatId: "chat_foreign",
      sessionId: "terminal_bound",
    })).resolves.toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    { name: "terminal_bound", status: "exited", recoverable: false },
    { name: "terminal_bound", status: "active", recoverable: true },
    { name: "terminal_renamed", status: "active", recoverable: false },
  ])("rejects unavailable live state %#", async (session) => {
    await expect(authorizeChatTerminalAttach({
      repository: {
        getTerminalBinding: vi.fn(async () => ({ sessionCreatedAt: "2026-08-28T10:00:00.000Z" })),
      },
      registry: {
        get: vi.fn(async () => ({ ...session, createdAt: "2026-08-28T10:00:00.000Z", incarnationVerified: true })),
      },
      owner,
      chatId: "chat_selected",
      sessionId: "terminal_bound",
    })).resolves.toBe(false);
  });

  it("fails closed on invalid identifiers and dependency errors", async () => {
    await expect(authorizeChatTerminalAttach({
      repository: { getTerminalBinding: vi.fn(async () => { throw new Error("private database failure"); }) },
      registry: { get: vi.fn() },
      owner,
      chatId: "chat_selected",
      sessionId: "terminal_bound",
    })).resolves.toBe(false);
    await expect(authorizeChatTerminalAttach({
      repository: {
        getTerminalBinding: vi.fn(async () => ({ sessionCreatedAt: "2026-08-28T10:00:00.000Z" })),
      },
      registry: { get: vi.fn() },
      owner,
      chatId: "not a chat id",
      sessionId: "terminal_bound",
    })).resolves.toBe(false);
  });

  it("rejects a replacement shell that reuses the bound session name", async () => {
    await expect(authorizeChatTerminalAttach({
      repository: {
        getTerminalBinding: vi.fn(async () => ({ sessionCreatedAt: "2026-08-28T10:00:00.000Z" })),
      },
      registry: {
        get: vi.fn(async () => ({
          name: "terminal_bound",
          status: "active",
          recoverable: false,
          createdAt: "2026-08-28T10:05:00.000Z",
          incarnationVerified: true,
        })),
      },
      owner,
      chatId: "chat_selected",
      sessionId: "terminal_bound",
    })).resolves.toBe(false);
  });

  it("rejects a matching timestamp unless the live runtime verified the incarnation", async () => {
    await expect(authorizeChatTerminalAttach({
      repository: {
        getTerminalBinding: vi.fn(async () => ({ sessionCreatedAt: "2026-08-28T10:00:00.000Z" })),
      },
      registry: {
        get: vi.fn(async () => ({
          name: "terminal_bound",
          status: "active",
          recoverable: false,
          createdAt: "2026-08-28T10:00:00.000Z",
          incarnationVerified: false,
        })),
      },
      owner,
      chatId: "chat_selected",
      sessionId: "terminal_bound",
    })).resolves.toBe(false);
  });

  it("fails closed for legacy bindings without a session incarnation", async () => {
    const get = vi.fn();
    await expect(authorizeChatTerminalAttach({
      repository: { getTerminalBinding: vi.fn(async () => ({ sessionCreatedAt: null })) },
      registry: { get },
      owner,
      chatId: "chat_selected",
      sessionId: "terminal_bound",
    })).resolves.toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});
