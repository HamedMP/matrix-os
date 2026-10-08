import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PLATFORM_SCHEMA_REVISION } from "../../packages/platform/src/database/migration-revision.js";

describe("platform schema revision", () => {
  it("changes whenever the ordered schema migrations change", async () => {
    const base = "packages/platform/src/database";
    const files = ["migrate.ts", "../ai-funded-reservation-indexes.ts", "../ai-funded-recovery-audit.ts", ...(await readdir(`${base}/migrations`))
      .filter((name) => name.endsWith(".ts") && name !== "whatsapp.ts")
      .map((name) => `migrations/${name}`)].sort();
    const digest = createHash("sha256");
    for (const file of files) {
      digest.update(file).update("\0").update(await readFile(`${base}/${file}`)).update("\0");
    }
    // Production has generation 14, while the shared Preview already applied a
    // different generation 15 fingerprint. The merged schema must advance past
    // both deployed predecessors rather than conflict or skip its new DDL.
    expect(PLATFORM_SCHEMA_REVISION.generation).toBeGreaterThan(15);
    expect(PLATFORM_SCHEMA_REVISION.fingerprint).toBe(digest.digest("hex"));
  });
});
