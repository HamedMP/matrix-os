import { existsSync } from "node:fs";
import os from "node:os";

// expo/metro-config pulls in untransformed ESM and cannot load under jest. The
// behaviour under test is this project's own watch-folder list, so the Expo
// defaults are stubbed.
jest.mock("expo/metro-config", () => ({
  getDefaultConfig: () => ({ watchFolders: [], resolver: {}, serializer: {} }),
}));

afterEach(() => jest.restoreAllMocks());

describe("mobile Metro configuration", () => {
  it("only watches folders that exist, so bundling works away from a developer Mac", () => {
    // Metro stats every watch folder before it bundles and throws on a missing
    // one. The pnpm global-store folder exists only on macOS dev machines, never
    // on the Linux runners that publish over-the-air updates.
    jest.spyOn(os, "homedir").mockReturnValue("/nonexistent-matrix-home");

    let config: { watchFolders?: string[] } = {};
    jest.isolateModules(() => {
      config = require("../metro.config.js") as { watchFolders?: string[] };
    });

    expect(config.watchFolders?.length).toBeGreaterThan(0);
    for (const folder of config.watchFolders ?? []) {
      expect(existsSync(folder)).toBe(true);
    }
  });
});
