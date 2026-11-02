import { describe, expect, it, vi } from "vitest";
import { formatAppRepairMessage, readBoundedRepairJson, submitAppRepairChat } from "../../packages/contracts/src/app-repair";
import { createCanonicalChatFixture, createCanonicalProviderCatalogFixture } from "./fixtures/canonical-chat";

describe("app repair chat", () => {
  it("rejects oversized streamed chat responses before buffering them", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1_000_001)); }, cancel }));
    await expect(readBoundedRepairJson(response)).rejects.toThrow("Repair chat unavailable");
    expect(cancel).toHaveBeenCalled();
  });
  it("bounds and sanitizes untrusted diagnostics while binding host context", () => {
    const text = formatAppRepairMessage({ app: "notes", surface: "Web Desktop", operation: "save", message: "POST https://host.test/private?token=secret123 failed for alice@example.com Bearer abcdefghijklmnop" });
    expect(text).toContain("App: notes");
    expect(text).toContain("Surface: Web Desktop");
    expect(text).toContain("Operation: save");
    expect(text).not.toContain("secret123");
    expect(text).not.toContain("alice@example.com");
    expect(text).not.toContain("abcdefghijklmnop");
  });

  it("confirms delivery only after canonical turn admission", async () => {
    const catalog = createCanonicalProviderCatalogFixture();
    catalog.instances[0] = { ...catalog.instances[0]!, id: "matrix_pi_default", driverKind: "matrix_pi", defaultSelection: { instanceId: "matrix_pi_default", model: "gpt-5.6-sol" } };
    catalog.drivers[0] = { ...catalog.drivers[0]!, kind: "matrix_pi" };
    const snapshot = createCanonicalChatFixture("accepted").snapshot;
    const { project: _project, providerBinding: _providerBinding, activeRun: _activeRun, ...chat } = snapshot.chat;
    const record = { chat };
    const request = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      if (path.startsWith("/api/chat-providers")) return catalog;
      if (path === "/api/chats") return record;
      if (path === "/api/chats/chat_fixture_accepted/turns") return { record, message: snapshot.messages[0], turn: snapshot.turns[0], run: snapshot.runs[0], admission: "accepted" };
      throw new Error("unexpected request");
    });
    await expect(submitAppRepairChat(request, { app: "notes", surface: "Native Mobile", operation: "save", message: "Write failed" })).resolves.toEqual({ chatId: "chat_fixture_accepted" });
    expect(JSON.parse(request.mock.calls[2]![1]!.body!)).toMatchObject({ parts: [{ type: "text", text: expect.stringContaining("App: notes") }], interactionMode: "default", permissionMode: "supervised" });
    const failed = vi.fn(async (path: string) => path.startsWith("/api/chat-providers") ? catalog : path === "/api/chats" ? record : Promise.reject(new Error("turn unavailable")));
    await expect(submitAppRepairChat(failed, { app: "notes", surface: "Native Mobile", operation: "save", message: "Write failed" })).rejects.toThrow("turn unavailable");
  });
});
