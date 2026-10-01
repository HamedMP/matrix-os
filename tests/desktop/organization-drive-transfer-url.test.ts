import { describe, expect, it } from "vitest";
import { validateDriveTransferUrl } from "../../desktop/src/main/files/organization-drive-transfer-url";

describe("native drive transfer URL", () => {
  it("rejects local and private destinations", async () => {
    for (const url of ["http://example.com/object", "https://localhost/object",
      "https://127.0.0.1/object", "https://169.254.169.254/object", "https://user:pass@example.com/object"]) {
      await expect(validateDriveTransferUrl(url)).rejects.toThrow();
    }
  });

  it("rejects a hostname that resolves to a private address", async () => {
    await expect(validateDriveTransferUrl("https://r2.example.com/object", async () =>
      [{ address: "10.0.0.4", family: 4 }])).rejects.toThrow();
  });

  it("accepts a public HTTPS destination after DNS validation", async () => {
    await expect(validateDriveTransferUrl("https://r2.example.com/object", async () =>
      [{ address: "1.1.1.1", family: 4 }])).resolves.toBeUndefined();
  });
});
