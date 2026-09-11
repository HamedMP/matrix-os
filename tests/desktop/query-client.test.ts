import { describe, expect, it } from "vitest";
import { createDesktopQueryClient, desktopQueryScope } from "@desktop/renderer/src/lib/query-client";

describe("desktop query client", () => {
  it("keeps cache identity scoped to the authenticated runtime", () => {
    expect(desktopQueryScope({ platformHost: "https://app.matrix-os.com", authGeneration: 7, runtimeSlot: "work" })).toEqual([
      "https://app.matrix-os.com",
      7,
      "work",
    ]);
  });

  it("does not retry mutations and does not refetch queries on window focus", () => {
    const client = createDesktopQueryClient();
    expect(client.getDefaultOptions().mutations?.retry).toBe(false);
    expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
  });
});
