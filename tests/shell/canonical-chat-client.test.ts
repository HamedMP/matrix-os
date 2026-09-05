import { describe, expect, it, vi } from "vitest";
import {
  createCanonicalShellChatClient,
  projectCanonicalMessages,
} from "../../shell/src/lib/canonical-chat-client.js";

const record = {
  chat: {
    id: "chat_shell_test",
    ownerScope: { type: "personal" as const, ownerId: "owner_shell" },
    title: "Shell chat",
    lifecycle: "active" as const,
    attention: "none" as const,
    revision: 0,
    messageCount: 0,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  },
};

describe("canonical shell Chat client", () => {
  it("lists and creates global Chats through the canonical routes with strict responses", async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/chats?")) return Response.json({ items: [record] });
      expect(JSON.parse(String(init?.body))).toEqual({
        clientRequestId: "req_shell_create",
        title: "Shell chat",
        currentSelection: { instanceId: "pi_default", model: "anthropic:claude-sonnet-5" },
      });
      return Response.json(record, { status: 201 });
    });
    const client = createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn });

    await expect(client.list()).resolves.toEqual({ items: [record] });
    await expect(client.create({
      clientRequestId: "req_shell_create",
      title: "Shell chat",
      currentSelection: { instanceId: "pi_default", model: "anthropic:claude-sonnet-5" },
    })).resolves.toEqual(record);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "https://matrix.test/api/chats?limit=100&scope=global",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "https://matrix.test/api/chats",
      expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json" } }),
    );
  });

  it("renames a Chat through the canonical revision-guarded endpoint", async () => {
    const renamed = { ...record, chat: { ...record.chat, title: "Release plan", revision: 1 } };
    const fetchFn = vi.fn(async () => Response.json(renamed));
    const client = createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn });

    await expect(client.updateTitle("chat_shell_test", {
      baseRevision: 0,
      title: "Release plan",
    })).resolves.toEqual(renamed);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://matrix.test/api/chats/chat_shell_test/title",
      expect.objectContaining({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, title: "Release plan" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("projects canonical parts without exposing raw structured payloads", () => {
    expect(projectCanonicalMessages([{
      id: "msg_shell_user", chatId: "chat_shell_test", seq: 1, role: "user", state: "committed",
      parts: [{ type: "text", text: "Hello" }], createdAt: "2026-08-31T00:00:00.000Z",
    }, {
      id: "msg_shell_tool", chatId: "chat_shell_test", seq: 2, role: "tool", state: "committed",
      parts: [{ type: "tool_request", toolCallId: "tool_1", name: "bash", label: "Run command" }],
      createdAt: "2026-08-31T00:00:01.000Z",
    }])).toEqual([
      expect.objectContaining({ id: "msg_shell_user", role: "user", content: "Hello" }),
      expect.objectContaining({ id: "msg_shell_tool", role: "system", content: "Using Run command...", tool: "bash" }),
    ]);
  });

  it("projects pending approvals and submits a bounded canonical decision", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => Response.json({
      approvalId: "approval_1", decision: "approve", submission: "accepted",
    }));
    const client = createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn });
    const projected = projectCanonicalMessages([{
      id: "msg_approval", chatId: "chat_shell_test", seq: 2, role: "system", state: "committed",
      runId: "run_shell", parts: [{
        type: "approval_request", approvalId: "approval_1", title: "Run command",
        description: "Allow this command?", risk: "medium", allowedDecisions: ["approve", "decline"],
      }], createdAt: "2026-08-31T00:00:02.000Z",
    }]);

    expect(projected[0]?.metadata?.canonicalApproval).toEqual({
      runId: "run_shell", approvalId: "approval_1", title: "Run command", description: "Allow this command?",
      risk: "medium", allowedDecisions: ["approve", "decline"], pending: true,
    });
    await client.submitApproval("chat_shell_test", "run_shell", "approval_1", "approve", "req_shell_approval");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://matrix.test/api/chats/chat_shell_test/runs/run_shell/approvals/approval_1",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ clientRequestId: "req_shell_approval", decision: "approve" }) }),
    );
  });

  it("resolves approvals by run and approval id instead of approval id alone", () => {
    const projected = projectCanonicalMessages([{
      id: "msg_request_a", chatId: "chat_shell_test", seq: 1, role: "system", state: "committed",
      runId: "run_a", parts: [{
        type: "approval_request", approvalId: "approval_reused", title: "Run A command",
        description: "Allow A?", risk: "medium", allowedDecisions: ["approve", "decline"],
      }], createdAt: "2026-08-31T00:00:01.000Z",
    }, {
      id: "msg_request_b", chatId: "chat_shell_test", seq: 2, role: "system", state: "committed",
      runId: "run_b", parts: [{
        type: "approval_request", approvalId: "approval_reused", title: "Run B command",
        description: "Allow B?", risk: "medium", allowedDecisions: ["approve", "decline"],
      }], createdAt: "2026-08-31T00:00:02.000Z",
    }, {
      id: "msg_result_a", chatId: "chat_shell_test", seq: 3, role: "system", state: "committed",
      runId: "run_a", parts: [{
        type: "approval_result", approvalId: "approval_reused", decision: "approve",
      }], createdAt: "2026-08-31T00:00:03.000Z",
    }]);

    expect(projected.find((message) => message.id === "msg_request_a")
      ?.metadata?.canonicalApproval?.pending).toBe(false);
    expect(projected.find((message) => message.id === "msg_request_b")
      ?.metadata?.canonicalApproval?.pending).toBe(true);
  });

  it("uploads bounded web attachments and returns canonical owner references", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(init?.body).toBeInstanceOf(Blob);
      return Response.json({ ok: true, path: "temporary/desktop-chat/stable-notes.txt", size: 5 });
    });
    const client = createCanonicalShellChatClient({
      gatewayUrl: "https://matrix.test",
      fetchFn,
      createId: () => "stable",
    });

    await expect(client.uploadAttachment({
      name: "notes.txt",
      type: "text/plain",
      data: "data:text/plain;base64,aGVsbG8=",
    })).resolves.toEqual({
      type: "attachment_reference",
      attachmentId: "shell_upload_stable",
      kind: "file",
      label: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      ownerReference: "temporary/desktop-chat/stable-notes.txt",
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://matrix.test/api/files/blob?path=temporary%2Fdesktop-chat%2Fstable-notes.txt",
      expect.objectContaining({
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("cleans a temporary upload through the scoped blob deletion route", async () => {
    const fetchFn = vi.fn(async () => Response.json({
      ok: true,
      path: "temporary/desktop-chat/stable-notes.txt",
      deleted: true,
    }));
    const client = createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn });

    await expect(client.deleteAttachment("temporary/desktop-chat/stable-notes.txt")).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith(
      "https://matrix.test/api/files/blob?path=temporary%2Fdesktop-chat%2Fstable-notes.txt",
      expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal) }),
    );
    await expect(client.deleteAttachment("projects/private.txt")).rejects.toThrow("InvalidAttachmentReference");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
