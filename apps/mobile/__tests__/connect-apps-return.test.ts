import { redirectSystemPath } from "../app/+native-intent";
import { MOBILE_INTEGRATIONS_REDIRECT_URI } from "../lib/requests/integrations";
import { connectAppsReturnPath, noteConnectAppsSignIn } from "../lib/connect-apps-return";

describe("where a Connect Apps sign-in returns", () => {
  beforeEach(() => {
    noteConnectAppsSignIn("apps");
  });

  it("leaves the return link to the Apps tab's Connect Apps when the sign-in began there", () => {
    expect(connectAppsReturnPath(MOBILE_INTEGRATIONS_REDIRECT_URI)).toBe(MOBILE_INTEGRATIONS_REDIRECT_URI);
  });

  it("brings a sign-in begun in Settings back to Connect Apps in Settings", () => {
    noteConnectAppsSignIn("settings");

    expect(connectAppsReturnPath(MOBILE_INTEGRATIONS_REDIRECT_URI)).toBe("/settings-detail/connect-apps");
    expect(connectAppsReturnPath("matrixos://integrations/")).toBe("/settings-detail/connect-apps");
    expect(connectAppsReturnPath("matrixos://integrations?status=success")).toBe("/settings-detail/connect-apps");
  });

  it("follows the latest sign-in's starting point", () => {
    noteConnectAppsSignIn("settings");
    noteConnectAppsSignIn("apps");

    expect(connectAppsReturnPath(MOBILE_INTEGRATIONS_REDIRECT_URI)).toBe(MOBILE_INTEGRATIONS_REDIRECT_URI);
  });

  it("passes every other link through untouched", () => {
    noteConnectAppsSignIn("settings");

    for (const link of [
      "matrixos://integrations-installed",
      "matrixos://integration-detail/github",
      "matrixos://terminal-session/abc",
      "https://app.matrix-os.com/integrations",
      "/integrations",
    ]) {
      expect(connectAppsReturnPath(link)).toBe(link);
    }
  });

  it("is what the router applies to links from outside the app", () => {
    noteConnectAppsSignIn("settings");

    expect(redirectSystemPath({ path: MOBILE_INTEGRATIONS_REDIRECT_URI, initial: false })).toBe("/settings-detail/connect-apps");
    expect(redirectSystemPath({ path: "matrixos://terminal-session/abc", initial: false })).toBe("matrixos://terminal-session/abc");
  });
});
