import { describe, expect, it, vi } from "vitest";
import {
  ComposeAttachError,
  attachmentRoom,
  bytesToBase64,
  checkAttachment,
  fileKindLabel,
  mimeTypeFor,
  readAttachment,
  type PickerFiles,
} from "../../../../home/apps/mail/src/compose/attachments";
import { MAX_DRAFT_ATTACHMENTS, MAX_DRAFT_REQUEST_BYTES, draftIssues, emptyDraft } from "../../../../home/apps/_shared/office-accounts/types/mail";

describe("bytesToBase64", () => {
  it("encodes standard padded base64", () => {
    expect(bytesToBase64(new TextEncoder().encode("Hello"))).toBe("SGVsbG8=");
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
    const big = new Uint8Array(70_000).map((_, i) => i % 256);
    expect(atob(bytesToBase64(big)).length).toBe(70_000);
  });
});

describe("attachment size checks", () => {
  it("computes the room left in the draft request", () => {
    const draft = { ...emptyDraft(), to: [{ address: "a@example.com" }], subject: "Hi" };
    const room = attachmentRoom(draft, "notes.docx");
    expect(room).toBeGreaterThan(40_000);
    expect(room).toBeLessThan(MAX_DRAFT_REQUEST_BYTES);
  });

  it("an attachment that fits keeps the draft valid; one byte more is refused", () => {
    const draft = { ...emptyDraft(), to: [{ address: "a@example.com" }] };
    const room = attachmentRoom(draft, "a.bin");
    expect(checkAttachment(draft, "a.bin", room)).toEqual({ ok: true });
    const bytes = new Uint8Array(room);
    const withFile = { ...draft, attachments: [{ name: "a.bin", mimeType: "application/octet-stream", size: room, contentBase64: bytesToBase64(bytes) }] };
    expect(draftIssues(withFile)).toEqual([]);
    expect(checkAttachment(draft, "a.bin", room + 3)).toEqual({ ok: false, code: "too_large" });
  });

  it("refuses more than the provider's attachment count", () => {
    const att = { name: "x.txt", mimeType: "text/plain", size: 1, contentBase64: "eA==" };
    const draft = { ...emptyDraft(), attachments: Array.from({ length: MAX_DRAFT_ATTACHMENTS }, () => att) };
    expect(checkAttachment(draft, "y.txt", 1)).toEqual({ ok: false, code: "too_many" });
  });
});

describe("readAttachment", () => {
  function files(size: number, bytes = new Uint8Array([1, 2, 3])): PickerFiles & { read: ReturnType<typeof vi.fn> } {
    return {
      list: vi.fn(),
      stat: vi.fn(async (path: string) => ({ path, size, modifiedAt: "", version: "v1" })),
      read: vi.fn(async (path: string) => ({ path, bytes, size: bytes.length, version: "v1", mimeType: "" })),
    };
  }

  it("checks the size before reading and builds a draft attachment", async () => {
    const host = files(3);
    const attachment = await readAttachment(host, "Documents/Plan.docx", emptyDraft());
    expect(attachment).toEqual({
      name: "Plan.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 3,
      contentBase64: "AQID",
    });
  });

  it("does not read a file that is too large", async () => {
    const host = files(5 * 1024 * 1024);
    await expect(readAttachment(host, "Videos/big.mp4", emptyDraft())).rejects.toMatchObject({ code: "too_large" });
    expect(host.read).not.toHaveBeenCalled();
  });

  it("rechecks the size of what was read", async () => {
    const host = files(3, new Uint8Array(200_000));
    await expect(readAttachment(host, "a.bin", emptyDraft())).rejects.toBeInstanceOf(ComposeAttachError);
  });

  it("maps bridge failures to a safe message", async () => {
    const host = files(3);
    host.read.mockRejectedValueOnce(Object.assign(new Error("ENOENT /home/secret"), { name: "BridgeFileError", code: "not_found" }));
    const error = await readAttachment(host, "a.txt", emptyDraft()).catch((e: unknown) => e as ComposeAttachError);
    expect(error).toBeInstanceOf(ComposeAttachError);
    expect((error as ComposeAttachError).message).not.toMatch(/ENOENT|secret/);
  });
});

describe("labels and types", () => {
  it("names documents from Docs and Sheets", () => {
    expect(fileKindLabel("Report.docx")).toBe("Docs document");
    expect(fileKindLabel("Budget.xlsx")).toBe("Sheets workbook");
    expect(fileKindLabel("data.csv")).toBe("Sheets workbook");
    expect(fileKindLabel("photo.png")).toBe("File");
    expect(mimeTypeFor("photo.PNG", "")).toBe("image/png");
    expect(mimeTypeFor("odd.zzz", "")).toBe("application/octet-stream");
    expect(mimeTypeFor("odd.zzz", "text/plain")).toBe("text/plain");
  });
});
