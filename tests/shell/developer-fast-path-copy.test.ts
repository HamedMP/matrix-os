import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("developer fast path onboarding copy", () => {
  it("keeps GitHub setup focused on Matrix-managed SSH keys instead of uploaded local secrets", () => {
    const stickers = readFileSync(
      join(root, "shell/src/components/onboarding/ManualSetupStickers.tsx"),
      "utf-8",
    );

    expect(stickers).toContain("Matrix-managed SSH key");
    expect(stickers).toContain("Do not upload local private keys");
    expect(stickers).toContain("Run GitHub browser login");
  });
});
