import { describe, expect, it } from "vitest";
import { CanonicalChatMessagePartSchema, CanonicalChatUserInputPartSchema } from "@matrix-os/contracts";
const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
describe("historical import canonical parts", () => {
  it("retains bounded historical provenance independently of an executable Turn", () => {
    const part = { type: "import_provenance", harness: "codex", sourceId, sourceKey: "a".repeat(64),
      phase: "commentary", origin: "assistant", offset: 100, end: 200 };
    expect(CanonicalChatMessagePartSchema.safeParse(part).success).toBe(true);
    expect(CanonicalChatUserInputPartSchema.safeParse(part).success).toBe(false);
    expect(CanonicalChatMessagePartSchema.safeParse({ ...part, offset: 201 }).success).toBe(false);
  });
  it("references an imported asset without accepting a caller-selected URL or key", () => {
    const part = { type: "import_reference", assetId: sourceId, kind: "image", label: "Imported image", mimeType: "image/png", sizeBytes: 100 };
    expect(CanonicalChatMessagePartSchema.safeParse(part).success).toBe(true);
    expect(CanonicalChatUserInputPartSchema.safeParse(part).success).toBe(false);
    expect(CanonicalChatMessagePartSchema.safeParse({ ...part, url: "https://untrusted.example" }).success).toBe(false);
  });
});
