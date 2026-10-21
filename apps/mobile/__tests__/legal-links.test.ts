import { Linking } from "react-native";

import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL, openLegalLink } from "../lib/legal-links";

describe("legal links", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("points at the published Matrix OS legal pages", () => {
    expect(PRIVACY_POLICY_URL).toBe("https://matrix-os.com/privacy");
    expect(TERMS_OF_SERVICE_URL).toBe("https://matrix-os.com/terms");
  });

  it("opens the requested page", () => {
    const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(true);

    openLegalLink(PRIVACY_POLICY_URL);

    expect(openUrl).toHaveBeenCalledWith("https://matrix-os.com/privacy");
  });

  it("logs instead of rejecting when the page cannot be opened", async () => {
    jest.spyOn(Linking, "openURL").mockRejectedValue(new TypeError("no handler"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => openLegalLink(PRIVACY_POLICY_URL)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith("[mobile] failed to open legal link", "TypeError");
  });
});
