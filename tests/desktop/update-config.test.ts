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

  it("uses the stable Desktop channel release for packaged builds by default", () => {
    expect(resolveUpdateFeedConfig({}, true)).toEqual({
      enabled: true,
      provider: "generic",
      url: "https://github.com/HamedMP/matrix-os/releases/download/desktop-stable/",
      channel: "stable",
      allowPrerelease: false,
    });
  });

  it("allows prerelease channels for beta and canary builds", () => {
    expect(
      resolveUpdateFeedConfig({ MATRIX_DESKTOP_UPDATE_CHANNEL: "canary" }, true),
    ).toMatchObject({
      enabled: true,
      provider: "generic",
      url: "https://github.com/HamedMP/matrix-os/releases/download/desktop-canary/",
      channel: "canary",
      allowPrerelease: true,
    });
  });

  it("allows dev builds to use the dev update channel", () => {
    expect(resolveUpdateFeedConfig({ MATRIX_DESKTOP_UPDATE_CHANNEL: "dev" }, true)).toMatchObject({
      enabled: true,
      provider: "generic",
      url: "https://github.com/HamedMP/matrix-os/releases/download/desktop-dev/",
      channel: "dev",
      allowPrerelease: true,
    });
  });

  it("uses the bundled release channel when runtime env is absent", () => {
    expect(resolveUpdateFeedConfig({}, true, "canary")).toMatchObject({
      enabled: true,
      provider: "generic",
      url: "https://github.com/HamedMP/matrix-os/releases/download/desktop-canary/",
      channel: "canary",
      allowPrerelease: true,
    });
  });

  it("keeps repository overrides inside the channel-specific Desktop feed", () => {
    expect(resolveUpdateFeedConfig({
      MATRIX_DESKTOP_RELEASE_OWNER: "example",
      MATRIX_DESKTOP_RELEASE_REPO: "desktop-releases",
      MATRIX_DESKTOP_UPDATE_CHANNEL: "beta",
    }, true)).toMatchObject({
      provider: "generic",
      url: "https://github.com/example/desktop-releases/releases/download/desktop-beta/",
      channel: "beta",
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
