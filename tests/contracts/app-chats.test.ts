import { describe, expect, it, vi } from "vitest";
import {
  APP_CHAT_OPERATION_SCOPES, APP_CHAT_OPERATIONS, AppChatRequestSchema, appChatBridgeSource, createAppChatClient,
} from "../../packages/contracts/src/app-chats";
import { AppCapabilityInputSchema, MAX_APP_CAPABILITY_BYTES, appCapabilityReplyBytes } from "../../packages/contracts/src/app-capabilities";

const chatId = "chat_0123456789abcdef";

describe("app chat contract", () => {
  it("assigns a scope to every operation and reserves approval and deletion", () => {
    expect(APP_CHAT_OPERATION_SCOPES.submitApproval).toBe("approve");
    expect(APP_CHAT_OPERATION_SCOPES.delete).toBe("delete");
    expect(APP_CHAT_OPERATION_SCOPES.sendTurn).toBe("send");
    expect(APP_CHAT_OPERATION_SCOPES.navigation).toBe("read");
    expect(APP_CHAT_OPERATION_SCOPES.access).toBeNull();
  });

  it("rejects unknown operations and undeclared fields", () => {
    expect(AppChatRequestSchema.safeParse({ op: "credentials" }).success).toBe(false);
    expect(AppChatRequestSchema.safeParse({ op: "navigation", path: "/api/chats/credentials" }).success).toBe(false);
  });

  it("does not accept a path traversal as a Chat identifier", () => {
    expect(AppChatRequestSchema.safeParse({ op: "get", chatId: "../credentials" }).success).toBe(false);
  });

  it("carries a Chat request through the capability contract and keeps integrations at their old limit", () => {
    expect(AppCapabilityInputSchema.safeParse({ kind: "chats", request: { op: "navigation", limit: 10 } }).success).toBe(true);
    const large = "x".repeat(100_000);
    expect(AppCapabilityInputSchema.safeParse({ kind: "chats", request: { op: "sendTurn", chatId, body: { text: large } } }).success).toBe(true);
    expect(AppCapabilityInputSchema.safeParse({ kind: "integrations.call", service: "gmail", action: "send", params: { body: large } }).success).toBe(false);
    expect(MAX_APP_CAPABILITY_BYTES).toBeGreaterThanOrEqual(256 * 1024);
  });

  it("allows Chat replies up to the database reply budget", () => {
    expect(appCapabilityReplyBytes({ kind: "chats", request: { op: "navigation" } })).toBe(8 * 1024 * 1024);
    expect(appCapabilityReplyBytes({ kind: "capabilities" })).toBe(256 * 1024);
  });

  it("throws a coded error from the typed client and exposes the raw reply", async () => {
    const invoke = vi.fn(async () => ({ ok: false, status: 409, error: { code: "stale_revision", safeMessage: "Reload the Chat.", retryable: true } }));
    const client = createAppChatClient(invoke);
    await expect(client.setPinned({ chatId, pinned: true })).rejects.toMatchObject({ message: "Reload the Chat.", code: "stale_revision", status: 409, retryable: true });
    await expect(client.request("setPinned", { chatId, pinned: true })).resolves.toMatchObject({ ok: false, status: 409 });
    expect(invoke).toHaveBeenCalledWith({ kind: "chats", request: { op: "setPinned", chatId, pinned: true } });
  });

  it("generates an injected client with the same operations and errors", async () => {
    const invoke = async () => ({ ok: false, status: 403, error: { code: "app_chat_denied", safeMessage: "Denied.", retryable: false } });
    const chats = new Function("invoke", `return ${appChatBridgeSource("invoke")};`)(invoke);
    for (const operation of APP_CHAT_OPERATIONS) expect(typeof chats[operation]).toBe("function");
    await expect(chats.navigation()).rejects.toMatchObject({ message: "Denied.", code: "app_chat_denied", status: 403 });
    await expect(chats.request("navigation")).resolves.toMatchObject({ ok: false });
  });
});
