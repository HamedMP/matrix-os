import { describe, expect, it, vi } from "vitest";
import { createPreviewDrivePlatformClient } from "../../packages/gateway/src/chat/preview-drive-platform-client.js";

const exact = { service: "google_drive", action: "list_files", label: "work", params: { maxResults: 3 } };

describe("Preview Drive Platform client", () => {
  it("redeems a browser-bound turn and never falls back to machine identity", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ runGrant: "a".repeat(64) }));
    const client = createPreviewDrivePlatformClient({ platformUrl: "https://platform.test", handle: "pr-1234",
      machineToken: "machine-only", fetcher });
    await expect(client.redeemTurn({ actorId: "owner", chatId: "chat_1", turnId: "cturn_1", runId: "run_1",
      clientRequestId: "req_1", bodyDigest: "b".repeat(64), proof: "browser-proof" })).resolves.toBe("a".repeat(64));
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://platform.test/internal/containers/pr-1234/preview-drive/turn/redeem");
    expect(new Headers(init!.headers).get("x-matrix-preview-drive-turn-proof")).toBe("browser-proof");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer machine-only");
    expect(JSON.parse(init!.body as string)).toEqual({ actorId: "owner", chatId: "chat_1", turnId: "cturn_1",
      runId: "run_1", clientRequestId: "req_1", bodyDigest: "b".repeat(64) });
    await expect(client.redeemTurn({ actorId: "owner", chatId: "chat_1", turnId: "cturn_1", runId: "run_1",
      clientRequestId: "req_1", bodyDigest: "b".repeat(64), proof: "" })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("sends an exact Drive approval digest and one-use grant to separate endpoints", async () => {
    const fetcher = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith("/grants")
      ? { actionGrant: "c".repeat(64) } : { data: { files: [] }, service: "google_drive", action: "list_files" }));
    const client = createPreviewDrivePlatformClient({ platformUrl: "https://platform.test", handle: "pr-1234",
      machineToken: "machine-only", fetcher });
    const scope = { runGrant: "a".repeat(64), chatId: "chat_1", runId: "run_1" };
    await expect(client.grantAction({ ...scope, approvalId: "integration_1", clientRequestId: "req_2",
      actionDigest: "d".repeat(64), action: exact, proof: "approved-browser" })).resolves.toBe("c".repeat(64));
    await expect(client.execute({ ...scope, actionGrant: "c".repeat(64), action: exact })).resolves.toEqual({
      data: { files: [] }, service: "google_drive", action: "list_files",
    });
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get("x-matrix-custom-mcp-approval-proof"))
      .toBe("approved-browser");
    expect(new Headers(fetcher.mock.calls[1]![1]!.headers).has("x-matrix-custom-mcp-approval-proof"))
      .toBe(false);
    expect(fetcher.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual(["grants", "execute"]);
  });

  it("matches the Platform projector's metadata field limits", async () => {
    const file = { id: "i".repeat(256), name: "n".repeat(1_024), mimeType: "m".repeat(2_000),
      modifiedTime: "t".repeat(2_000), size: "s".repeat(2_000), webViewLink: "u".repeat(2_000) };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: { files: [file] },
      service: "google_drive", action: "list_files" }));
    const client = createPreviewDrivePlatformClient({ platformUrl: "https://platform.test", handle: "pr-1234",
      machineToken: "machine-only", fetcher });
    await expect(client.execute({ runGrant: "a".repeat(64), chatId: "chat_1", runId: "run_1",
      actionGrant: "c".repeat(64), action: exact })).resolves.toEqual({ data: { files: [file] },
      service: "google_drive", action: "list_files" });
  });

  it.each([
    { id: "i".repeat(257), name: "safe" },
    { id: "safe", name: "n".repeat(1_025) },
  ])("rejects metadata that Platform would not project %#", async file => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: { files: [file] },
      service: "google_drive", action: "list_files" }));
    const client = createPreviewDrivePlatformClient({ platformUrl: "https://platform.test", handle: "pr-1234",
      machineToken: "machine-only", fetcher });
    await expect(client.execute({ runGrant: "a".repeat(64), chatId: "chat_1", runId: "run_1",
      actionGrant: "c".repeat(64), action: exact })).rejects.toThrow();
  });
});
