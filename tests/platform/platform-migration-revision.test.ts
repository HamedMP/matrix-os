import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PLATFORM_SCHEMA_REVISION } from "../../packages/platform/src/database/migration-revision.js";

describe("platform schema revision", () => {
  it("changes whenever the ordered schema migrations change", async () => {
    const base = "packages/platform/src/database";
    const files = ["migrate.ts", "../ai-funded-reservation-indexes.ts", ...(await readdir(`${base}/migrations`))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `migrations/${name}`)].sort();
    const digest = createHash("sha256");
    for (const file of files) {
      digest.update(file).update("\0").update(await readFile(`${base}/${file}`)).update("\0");
    }
    expect(PLATFORM_SCHEMA_REVISION.generation).toBeGreaterThan(0);
    expect(PLATFORM_SCHEMA_REVISION.fingerprint).toBe(digest.digest("hex"));
  });
});
