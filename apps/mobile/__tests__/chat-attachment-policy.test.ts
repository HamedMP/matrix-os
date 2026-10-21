import { chatAttachmentSubmissionError } from "../lib/chat-attachment-policy";
import { attachment, attachmentCatalog, managedSelection, MiB } from "./attachment-policy-fixtures";

describe("Native Mobile managed attachment preflight", () => {
  const catalog = attachmentCatalog();
  const errorFor = (parts: Parameters<typeof chatAttachmentSubmissionError>[2], selection = managedSelection) => (
    chatAttachmentSubmissionError(catalog, selection, parts)
  );

  it.each([
    ["GIF", [attachment({ mimeType: "image/gif", name: "photo.gif" })], "Use PNG, JPEG or WebP images for this model."],
    ["large file", [attachment({ kind: "file", mimeType: "application/pdf", sizeBytes: 10 * MiB + 1 })], "Files must be 10 MiB or smaller for this model."],
    ["large image", [attachment({ sizeBytes: 2 * MiB + 1 })], "Images must be 2 MiB or smaller for this model."],
    ["five images", Array.from({ length: 5 }, () => attachment()), "Attach up to four images per message."],
    ["funded image total", [attachment({ sizeBytes: MiB / 2 }), attachment({ sizeBytes: MiB / 2 + 1 })], "Images for this Matrix AI source must total 1 MiB or less."],
    ["nine files", Array.from({ length: 9 }, () => attachment({ kind: "file" })), "Attach up to eight files per message."],
  ])("rejects %s with the shared safe error", (_case, parts, error) => {
    expect(errorFor(parts)).toBe(error);
  });

  it("uses the selected model's vision capability", () => {
    expect(errorFor([attachment()], { ...managedSelection, model: "text" }))
      .toBe("The selected model does not support images.");
    expect(errorFor([attachment()], { ...managedSelection, model: "missing" }))
      .toBe("The selected model does not support images.");
  });

  it.each(["image/png", "image/jpeg", "image/webp"])("allows %s at the funded limit", (mimeType) => {
    expect(errorFor([attachment({ mimeType, sizeBytes: MiB })])).toBeNull();
  });

  it("allows files at 10 MiB, text-only sends, and existing coding-agent file policy", () => {
    expect(errorFor([attachment({ kind: "file", sizeBytes: 10 * MiB })])).toBeNull();
    expect(chatAttachmentSubmissionError(null, null, [])).toBeNull();
    expect(errorFor([attachment({ kind: "file", sizeBytes: 5 * MiB })], { instanceId: "codex_default", model: "vision" })).toBeNull();
  });

  it("uses current instance and options for the funded image budget", () => {
    const parts = [attachment({ sizeBytes: 2 * MiB })];
    expect(errorFor(parts, { instanceId: "matrix_pi_own", model: "vision" })).toBeNull();
    const selection = { instanceId: "matrix_bot_default", model: "vision" };
    expect(errorFor(parts, selection)).toContain("total 1 MiB");
    expect(chatAttachmentSubmissionError(catalog, { ...selection, options: [{ id: "source", value: "own" }] }, parts)).toBeNull();
  });

  it("allows 20 MiB of files while preserving the independent image budget", () => {
    const selection = { instanceId: "matrix_pi_own", model: "vision" };
    const images = Array.from({ length: 4 }, () => attachment({ sizeBytes: 2 * MiB }));
    expect(errorFor(images, selection)).toBeNull();
    expect(errorFor([...images, attachment({ kind: "file", sizeBytes: 10 * MiB })], selection)).toBeNull();
    const files = [attachment({ kind: "file", sizeBytes: 10 * MiB }), attachment({ kind: "file", sizeBytes: 10 * MiB })];
    expect(errorFor(files, selection)).toBeNull();
    expect(errorFor([...files, attachment({ kind: "file", sizeBytes: 1 })], selection))
      .toBe("Attachments must total 20 MiB or less.");
  });

  it("applies the Web recipe automatic policy without treating auto as a catalog vision model", () => {
    const selection = { instanceId: "matrix_bot_default", model: "auto" };
    expect(chatAttachmentSubmissionError(null, selection, [attachment()], true)).toBeNull();
    expect(chatAttachmentSubmissionError(null, selection, [attachment({ sizeBytes: MiB + 1 })], true)).toContain("total 1 MiB");
    expect(chatAttachmentSubmissionError(catalog, selection, [attachment()])).toContain("does not support images");
    expect(chatAttachmentSubmissionError(catalog, { ...selection, instanceId: "matrix_pi_default" }, [attachment()], true))
      .toContain("does not support images");
  });

  it("holds attachments when the selected instance does not support uploads", () => {
    expect(chatAttachmentSubmissionError(null, managedSelection, [attachment()])).toBe("The selected provider does not support file attachments.");
    const unavailable = attachmentCatalog();
    unavailable.instances[0]!.supports.attachments = [];
    expect(chatAttachmentSubmissionError(unavailable, managedSelection, [attachment()])).toBe("The selected provider does not support file attachments.");
  });
});
