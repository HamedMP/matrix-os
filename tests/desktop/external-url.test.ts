import { describe, expect, it } from "vitest";
import {
  createExternalHttpUrlOpener,
  safeExternalHttpUrl,
} from "@desktop/main/external-url";

describe("safeExternalHttpUrl", () => {
  it("allows normalized HTTP and HTTPS URLs", () => {
    expect(safeExternalHttpUrl("https://example.org/docs")).toBe("https://example.org/docs");
    expect(safeExternalHttpUrl("http://localhost:3000/status")).toBe(
      "http://localhost:3000/status",
    );
  });

  it("rejects unsafe schemes, credentials, and malformed values", () => {
    expect(safeExternalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalHttpUrl("https://user:pass@example.org/private")).toBeNull();
    expect(safeExternalHttpUrl("not a URL")).toBeNull();
  });

  it("suppresses operating-system browser launches during automated Desktop checks", async () => {
    const opened: string[] = [];
    const openExternalHttpUrl = createExternalHttpUrlOpener({
      disabled: true,
      openExternal: async (url) => {
        opened.push(url);
      },
    });

    await openExternalHttpUrl("https://example.test/activate");

    expect(opened).toEqual([]);
  });

  it("opens safe URLs when automation suppression is disabled", async () => {
    const opened: string[] = [];
    const openExternalHttpUrl = createExternalHttpUrlOpener({
      disabled: false,
      openExternal: async (url) => {
        opened.push(url);
      },
    });

    await openExternalHttpUrl("https://app.matrix-os.com/auth/device");

    expect(opened).toEqual(["https://app.matrix-os.com/auth/device"]);
  });
});
