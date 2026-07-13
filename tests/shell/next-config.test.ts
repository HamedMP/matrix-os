import { describe, expect, it } from "vitest";
import nextConfig from "../../shell/next.config";

describe("shell Next configuration", () => {
  it("resolves NodeNext JavaScript specifiers to TypeScript workspace sources", () => {
    const config = {
      resolve: {
        extensionAlias: {
          ".mjs": [".mts", ".mjs"],
        },
      },
    };

    const configured = nextConfig.webpack?.(config as never, {} as never) as typeof config;

    expect(configured.resolve.extensionAlias).toEqual({
      ".mjs": [".mts", ".mjs"],
      ".js": [".ts", ".tsx", ".js"],
    });
  });
});
