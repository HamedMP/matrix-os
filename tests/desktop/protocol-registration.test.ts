import { describe, expect, it, vi } from "vitest";
import { registerWindowsProtocolClients } from "../../desktop/src/main/platform/protocol-registration";

describe("registerWindowsProtocolClients", () => {
  it("registers both supported deep-link schemes for a packaged Windows app", () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);

    const failed = registerWindowsProtocolClients(
      { isPackaged: true, setAsDefaultProtocolClient },
      "win32",
    );

    expect(setAsDefaultProtocolClient.mock.calls).toEqual([["matrixos"], ["matrix-os"]]);
    expect(failed).toEqual([]);
  });

  it("does not claim the schemes outside a packaged Windows app", () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);

    expect(
      registerWindowsProtocolClients(
        { isPackaged: false, setAsDefaultProtocolClient },
        "win32",
      ),
    ).toEqual([]);
    expect(
      registerWindowsProtocolClients(
        { isPackaged: true, setAsDefaultProtocolClient },
        "darwin",
      ),
    ).toEqual([]);
    expect(setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it("reports schemes that Electron could not register", () => {
    const setAsDefaultProtocolClient = vi.fn((scheme: string) => scheme !== "matrix-os");

    expect(
      registerWindowsProtocolClients(
        { isPackaged: true, setAsDefaultProtocolClient },
        "win32",
      ),
    ).toEqual(["matrix-os"]);
  });
});
