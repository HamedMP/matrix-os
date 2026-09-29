import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importCodexPreview, previewCodexFile } from "../../src/cli/codex-chat-import.js";
import { safeCodexImportError } from "../../src/cli/commands/chats.js";

const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
let directory = "";
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("CLI Codex Chat import", () => {
  it("does not print raw filesystem or gateway error details", () => {
    expect(safeCodexImportError(new Error("EACCES /home/someone/private.jsonl")))
      .toBe("Chat import failed. Check the selected file and connection, then retry.");
  });
  it("previews selected local history and sends only the projected conversation to the authenticated owner", async () => {
    directory = await mkdtemp(join(tmpdir(), "matrix-codex-import-"));
    const file = join(directory, "rollout-example.jsonl");
    await writeFile(file, [
      JSON.stringify({ type: "session_meta", payload: { id: sourceId, cwd: "/work/example" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-09-03T16:01:00Z", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "Build a menu" }],
      } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "private tool output" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-09-03T16:03:00Z", payload: {
        type: "message", role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", text: "Menu built." }],
      } }),
    ].join("\n") + "\n");
    const preview = await previewCodexFile(file);
    expect(preview).toMatchObject({ sourceId, cwd: "/work/example", title: "Build a menu" });
    expect(preview.messages.map((message) => message.text)).toEqual(["Build a menu", "Menu built."]);

    const requests: Array<{ path: string; body: unknown }> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
      requests.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/complete")) return Response.json({ chatId: "chat_imported", messageCount: 2 });
      if (url.pathname.endsWith("/messages")) return Response.json({ nextSeq: 3 });
      if (url.pathname.endsWith("/chat_imported")) return Response.json({ record: { chat: { messageCount: 2 } } });
      return Response.json({ status: "uploading", nextSeq: 1 }, { status: 201 });
    });
    expect(await importCodexPreview(preview, { gatewayUrl: "https://computer.example", token: "test-token" }, fetchFn))
      .toMatchObject({ chatId: "chat_imported", messageCount: 2 });
    expect(requests.map((request) => request.path)).toEqual([
      "/api/chats/imports/codex",
      `/api/chats/imports/codex/${sourceId}/messages`,
      `/api/chats/imports/codex/${sourceId}/complete`,
      "/api/chats/chat_imported",
    ]);
    expect(JSON.stringify(requests)).not.toContain("private tool output");
    expect(fetchFn.mock.calls.every((call) => (call[1] as RequestInit).headers
      && ((call[1] as RequestInit).headers as Record<string, string>).authorization === "Bearer test-token")).toBe(true);
  });
});
