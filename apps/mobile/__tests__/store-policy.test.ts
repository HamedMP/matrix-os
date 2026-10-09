import { Platform } from "react-native";

import { allowsExternalPurchaseLinks } from "../lib/store-policy";

describe("allowsExternalPurchaseLinks", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(["ios", "android"] as const)("blocks external purchase links in the %s store build", (os) => {
    expect(allowsExternalPurchaseLinks(os)).toBe(false);
  });

  it("keeps external purchase links in the web build", () => {
    expect(allowsExternalPurchaseLinks("web")).toBe(true);
  });

  it.each(["macos", "windows"] as const)("fails closed for other native platforms (%s)", (os) => {
    expect(allowsExternalPurchaseLinks(os)).toBe(false);
  });

  it("defaults to the running platform", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    expect(allowsExternalPurchaseLinks()).toBe(false);

    jest.replaceProperty(Platform, "OS", "android");
    expect(allowsExternalPurchaseLinks()).toBe(false);

    jest.replaceProperty(Platform, "OS", "web");
    expect(allowsExternalPurchaseLinks()).toBe(true);
  });
});
