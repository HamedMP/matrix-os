import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("collaborative app lock order", () => {
  it("locks only the binding after the live scope so readiness invalidation cannot deadlock", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/gateway/src/collaboration/app-instance-adapter.ts"),
      "utf8",
    );
    expect(source).toContain('query.forUpdate("binding")');
    expect(source).toContain('query.forShare("binding")');
  });
});
