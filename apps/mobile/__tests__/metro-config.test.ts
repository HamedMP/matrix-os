import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

  describe("workspace TypeScript packages", () => {
    type Resolve = (context: { originModulePath: string; resolveRequest: jest.Mock }, moduleName: string, platform: string) => unknown;
    const packages = path.resolve(__dirname, "../../../packages");

    function resolver(): Resolve {
      let config: { resolver?: { resolveRequest?: Resolve } } = {};
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        config = require("../metro.config.js") as typeof config;
      });
      return config.resolver!.resolveRequest!;
    }

    it("finds the TypeScript source a package imports by its built name", () => {
      const fallback = jest.fn();

      const resolved = resolver()({ originModulePath: path.join(packages, "ui/src/speech/index.ts"), resolveRequest: fallback }, "./pcm.js", "ios");

      expect(resolved).toEqual({ type: "sourceFile", filePath: path.join(packages, "ui/src/speech/pcm.ts") });
      expect(fallback).not.toHaveBeenCalled();
    });

    it("leaves other imports to Metro", () => {
      const fallback = jest.fn(() => ({ type: "empty" }));
      const resolve = resolver();

      // A built name that is not a sibling source file, and an import from outside the packages.
      resolve({ originModulePath: path.join(packages, "ui/src/speech/index.ts"), resolveRequest: fallback }, "./missing.js", "ios");
      resolve({ originModulePath: path.resolve(__dirname, "../lib/speech/capture.ts"), resolveRequest: fallback }, "./pcm.js", "ios");

      expect(fallback).toHaveBeenCalledTimes(2);
    });
  });
});
