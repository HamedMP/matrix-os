import type { ComposerAttachment } from "@/lib/chat-attachments";
import { removeChatAttachment, uploadChatAttachment } from "@/lib/requests/chat-attachments";

const mockPutDeviceFile = jest.fn();

jest.mock("@/lib/device-file-upload", () => ({
  putDeviceFile: (...args: unknown[]) => mockPutDeviceFile(...args),
}));

const gatewayUrl = "https://app.matrix-os.com/vm/alice";
const token = "clerk-token";
const path = "temporary/desktop-chat/att_a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4-Receipt.jpg";
const blobUrl = `${gatewayUrl}/api/files/blob?path=${encodeURIComponent(path)}`;

const attachment: ComposerAttachment = {
  id: "att_a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4",
  uri: "file:///cache/Receipt.jpg",
  name: "Receipt.jpg",
  mimeType: "image/jpeg",
  kind: "image",
  sizeBytes: 2_048,
};

function stored(body: unknown, status = 200) {
  return { status, body: JSON.stringify(body) };
}

describe("chat attachment requests", () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    warn.mockRestore();
    jest.clearAllMocks();
  });

  describe("upload", () => {
    it("puts the file in the chat upload folder, never asking to write over what is there", async () => {
      mockPutDeviceFile.mockResolvedValue(stored({ ok: true, path, size: 2_048 }));

      await expect(uploadChatAttachment(token, gatewayUrl, attachment)).resolves.toEqual({ path, created: true });

      expect(mockPutDeviceFile).toHaveBeenCalledTimes(1);
      const upload = mockPutDeviceFile.mock.calls[0]![0];
      expect(upload).toMatchObject({
        uri: "file:///cache/Receipt.jpg",
        url: blobUrl,
        headers: { Authorization: "Bearer clerk-token", "Content-Type": "image/jpeg" },
      });
      expect(upload.url).not.toContain("force");
      // The upload cannot outlast its time limit.
      expect(upload.signal).toBeInstanceOf(AbortSignal);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("finds an attachment that an earlier try already uploaded, and says it did not put it there", async () => {
      mockPutDeviceFile.mockResolvedValue(stored({ error: "file_exists" }, 409));

      await expect(uploadChatAttachment(token, gatewayUrl, attachment)).resolves.toEqual({ path, created: false });
      // A turn may already name it: it is left alone.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ["the computer refuses it", stored({ error: "payload_too_large" }, 413)],
      ["the place is taken by something that is not a file", stored({ error: "not_file" }, 409)],
      ["the answer is far longer than an upload's", { status: 200, body: "x".repeat(10_000) }],
    ])("fails in plain words when %s, with nothing stored to remove", async (_case, result) => {
      mockPutDeviceFile.mockResolvedValue(result);

      await expect(uploadChatAttachment(token, gatewayUrl, attachment))
        .rejects.toThrow("Could not upload the attachment. Try again.");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ["the answer is not what an upload answers", stored({ ok: true })],
      ["the answer names another place", stored({ ok: true, path: "temporary/desktop-chat/other.jpg", size: 2_048 })],
      ["only part of the file arrived", stored({ ok: true, path, size: 1_000 })],
      ["the answer is not JSON", { status: 200, body: "<html>" }],
    ])("fails when %s, and removes what was stored so a later try does not find it in place", async (_case, result) => {
      mockPutDeviceFile.mockResolvedValue(result);
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, path, deleted: true }) });

      await expect(uploadChatAttachment(token, gatewayUrl, attachment))
        .rejects.toThrow("Could not upload the attachment. Try again.");
      expect(fetchMock).toHaveBeenCalledWith(blobUrl, expect.objectContaining({ method: "DELETE" }));
    });

    it("still fails in plain words when what was stored cannot be removed", async () => {
      mockPutDeviceFile.mockResolvedValue(stored({ ok: true, path, size: 1_000 }));
      fetchMock.mockRejectedValue(new Error("offline"));

      await expect(uploadChatAttachment(token, gatewayUrl, attachment))
        .rejects.toThrow("Could not upload the attachment. Try again.");
    });

    it("fails in plain words when the upload itself fails, without passing its reason on", async () => {
      mockPutDeviceFile.mockRejectedValue(new Error("ECONNRESET at /Users/alice/secret"));

      await expect(uploadChatAttachment(token, gatewayUrl, attachment))
        .rejects.toThrow("Could not upload the attachment. Try again.");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    });

    it.each([
      ["no session token", " ", gatewayUrl, attachment],
      ["a computer address that is not a URL", token, "not a url", attachment],
      ["an attachment this app did not make", token, gatewayUrl, { ...attachment, id: "../escape" }],
    ])("sends nothing with %s", async (_case, withToken, withGateway, withAttachment) => {
      await expect(uploadChatAttachment(withToken, withGateway, withAttachment))
        .rejects.toThrow("Could not upload the attachment. Try again.");
      expect(mockPutDeviceFile).not.toHaveBeenCalled();
    });
  });

  describe("removal", () => {
    it("asks the computer to remove the upload", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, path, deleted: true }) });

      await expect(removeChatAttachment(token, gatewayUrl, path)).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledWith(
        blobUrl,
        expect.objectContaining({ method: "DELETE", headers: { Authorization: "Bearer clerk-token" } }),
      );
    });

    it("counts an upload that was already gone as removed", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, path, deleted: false }) });

      await expect(removeChatAttachment(token, gatewayUrl, path)).resolves.toBeUndefined();
    });

    it.each([
      ["the computer refuses", { ok: false, status: 400, json: async () => ({ error: "invalid_path" }) }],
      ["the answer names another place", { ok: true, status: 200, json: async () => ({ ok: true, path: "x", deleted: true }) }],
    ])("fails when %s", async (_case, response) => {
      fetchMock.mockResolvedValue(response);

      await expect(removeChatAttachment(token, gatewayUrl, path)).rejects.toThrow("Could not remove the attachment.");
    });
  });
});
