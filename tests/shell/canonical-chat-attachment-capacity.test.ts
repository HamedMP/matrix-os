import { expect, it, vi } from "vitest";
import { createCanonicalShellChatClient } from "../../shell/src/lib/canonical-chat-client.js";

it("sends an exact 10 MiB file as raw bytes and rejects an extra byte before uploading", async () => {
  const size = 10 * 1024 * 1024;
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.body).toBeInstanceOf(Blob);
    expect((init!.body as Blob).size).toBe(size);
    return Response.json({ ok: true, path: "temporary/desktop-chat/capacity-exact.bin", size });
  });
  const client = createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn, createId: () => "capacity" });
  const input = (bytes: number) => ({ name: "exact.bin", type: "application/octet-stream", data: `data:application/octet-stream;base64,${Buffer.alloc(bytes).toString("base64")}` });
  await expect(client.uploadAttachment(input(size))).resolves.toMatchObject({ kind: "file", sizeBytes: size });
  await expect(client.uploadAttachment(input(size + 1))).rejects.toThrow("AttachmentTooLarge");
  expect(fetchFn).toHaveBeenCalledOnce();
});
