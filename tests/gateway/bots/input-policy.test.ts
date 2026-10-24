import { expect, it } from "vitest";
import { botAttachmentInputError } from "@matrix-os/contracts";
it("accepts bounded vision images and readable files, retaining text-only file sends", () => {
  expect(botAttachmentInputError([{ kind: "image", mimeType: "image/png", sizeBytes: 10 }, { kind: "file", sizeBytes: 10 }], true)).toBeNull();
  expect(botAttachmentInputError([{ kind: "file", sizeBytes: 10 }], false)).toBeNull();
});
it.each([
  [[{ kind: "image", mimeType: "image/png", sizeBytes: 10 }], false],
  [[{ kind: "image", mimeType: "image/gif", sizeBytes: 10 }], true],
  [[{ kind: "image", mimeType: "image/png", sizeBytes: 2 * 1024 * 1024 + 1 }], true],
  [[{ kind: "file", sizeBytes: 10 * 1024 * 1024 + 1 }], true],
  [Array.from({ length: 5 }, () => ({ kind: "image", mimeType: "image/png", sizeBytes: 10 })), true],
] as const)("rejects unsupported inputs before dispatch", (parts, vision) => {
  expect(botAttachmentInputError(parts, vision)).toBeTruthy();
});
it("admits two 10 MiB files while preserving total, count and independent image budgets", () => {
  const file = { kind: "file", sizeBytes: 10 * 1024 * 1024 };
  expect(botAttachmentInputError([file, file], false)).toBeNull();
  expect(botAttachmentInputError([file, file, { kind: "file", sizeBytes: 1 }], false)).toBe("Attachments must total 20 MiB or less.");
  expect(botAttachmentInputError(Array.from({ length: 8 }, () => ({ kind: "file", sizeBytes: 1 })), false)).toBeNull();
  expect(botAttachmentInputError(Array.from({ length: 9 }, () => ({ kind: "file", sizeBytes: 1 })), false)).toContain("eight");
  expect(botAttachmentInputError(Array.from({ length: 4 }, () => ({ kind: "image", mimeType: "image/png", sizeBytes: 2 * 1024 * 1024 })), true)).toBeNull();
});
it("conservatively admits funded images below the Relay body cap without limiting subscription images", async () => {
  const { BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES } = await import("@matrix-os/contracts");
  const parts = [{ kind: "image", mimeType: "image/png", sizeBytes: 1024 * 1024 + 1 }];
  expect(botAttachmentInputError(parts, true)).toBeNull();
  expect(botAttachmentInputError(parts, true, BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES)).toContain("1 MiB");
});
