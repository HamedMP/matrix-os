import { describe, expect, it } from "vitest";
import { BrowserChromeModelSchema, BROWSER_CHROME_ACTIONS, parseBrowserChromeAction } from "../../packages/contracts/src/browser-chrome";

const valid = {
  surface: "browser",
  connection: "connected",
  control: "You are in control",
  busy: false,
  settingsOpen: false,
  actions: [{ id: "open-cloud-desktop", disabled: false }, { id: "settings", disabled: false }],
};

describe("Browser title bar chrome contract", () => {
  it("accepts the bounded model the Browser publishes to its window title bar", () => {
    expect(BrowserChromeModelSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ["free-text control label", { ...valid, control: "<img src=x onerror=alert(1)>" }],
    ["unknown action", { ...valid, actions: [{ id: "navigate", disabled: false }] }],
    ["extra field", { ...valid, href: "https://attacker.test" }],
    ["extra action field", { ...valid, actions: [{ id: "settings", disabled: false, label: "Pay now" }] }],
    ["duplicate actions", { ...valid, actions: [{ id: "settings", disabled: false }, { id: "settings", disabled: true }] }],
    ["too many actions", { ...valid, actions: BROWSER_CHROME_ACTIONS.map((id) => ({ id, disabled: false })).concat([{ id: "settings", disabled: false }]) }],
    ["unknown surface", { ...valid, surface: "terminal" }],
  ])("rejects a %s so the embed cannot inject arbitrary chrome", (_name, value) => {
    expect(BrowserChromeModelSchema.safeParse(value).success).toBe(false);
  });

  it("accepts only known actions coming back from the title bar", () => {
    expect(parseBrowserChromeAction("reconnect")).toBe("reconnect");
    expect(parseBrowserChromeAction("rm -rf")).toBeNull();
    expect(parseBrowserChromeAction({ id: "settings" })).toBeNull();
  });
});
