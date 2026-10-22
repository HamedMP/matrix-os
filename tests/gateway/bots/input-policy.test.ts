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
  [[{ kind: "file", sizeBytes: 1024 * 1024 + 1 }], true],
  [Array.from({ length: 5 }, () => ({ kind: "image", mimeType: "image/png", sizeBytes: 10 })), true],
] as const)("rejects unsupported inputs before dispatch", (parts, vision) => {
  expect(botAttachmentInputError(parts, vision)).toBeTruthy();
});
it("conservatively admits funded images below the Relay body cap without limiting subscription images", async () => {
  const { BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES } = await import("@matrix-os/contracts");
  const parts = [{ kind: "image", mimeType: "image/png", sizeBytes: 1024 * 1024 + 1 }];
  expect(botAttachmentInputError(parts, true)).toBeNull();
  expect(botAttachmentInputError(parts, true, BOT_FUNDED_IMAGE_TOTAL_MAX_BYTES)).toContain("1 MiB");
});
