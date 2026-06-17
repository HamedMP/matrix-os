import { describe, expect, it } from "vitest";
import { resolveUpdateFeedConfig } from "../../desktop/src/main/update-config";

describe("resolveUpdateFeedConfig", () => {
  it("disables update checks outside packaged builds", () => {
    expect(resolveUpdateFeedConfig({}, false)).toEqual({
      enabled: false,
      channel: "stable",
      allowPrerelease: false,
    });
  });

  it("uses GitHub releases for packaged stable builds by default", () => {
    expect(resolveUpdateFeedConfig({}, true)).toEqual({
      enabled: true,
      provider: "github",
      owner: "HamedMP",
      repo: "matrix-os",
      channel: "stable",
      allowPrerelease: false,
    });
  });

  it("allows prerelease channels for beta and canary builds", () => {
    expect(
      resolveUpdateFeedConfig({ MATRIX_DESKTOP_UPDATE_CHANNEL: "canary" }, true),
    ).toMatchObject({
      enabled: true,
      provider: "github",
      channel: "canary",
      allowPrerelease: true,
    });
  });

  it("uses the bundled release channel when runtime env is absent", () => {
    expect(resolveUpdateFeedConfig({}, true, "canary")).toMatchObject({
      enabled: true,
      provider: "github",
      channel: "canary",
      allowPrerelease: true,
    });
  });

  it("lets a generic feed override GitHub releases", () => {
    expect(
      resolveUpdateFeedConfig(
        {
          OPERATOR_UPDATE_FEED: "https://releases.matrix-os.com/desktop/stable",
          MATRIX_DESKTOP_UPDATE_CHANNEL: "beta",
        },
        true,
      ),
    ).toEqual({
      enabled: true,
      provider: "generic",
      url: "https://releases.matrix-os.com/desktop/stable",
      channel: "beta",
      allowPrerelease: true,
    });
  });
});
