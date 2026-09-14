import { describe, expect, it } from "vitest";
import { createShellQueryClient } from "@/api/query-client";

describe("shell query client", () => {
  it("uses non-persistent, conservative retry defaults", () => {
    const client = createShellQueryClient();
    expect(client.getDefaultOptions().queries?.retry).toBe(1);
    expect(client.getDefaultOptions().mutations?.retry).toBe(false);
    expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
  });
});
