import { describe, expect, it } from "vitest";
import {
  formatUnsupportedNodeError,
  isSupportedNodeVersion,
} from "../../src/lib/node-runtime-guard.mjs";

describe("node runtime guard", () => {
  it("rejects Node versions older than 24", () => {
    expect(isSupportedNodeVersion("v20.17.0")).toBe(false);
    expect(isSupportedNodeVersion("v22.12.0")).toBe(false);
  });

  it("allows Node 24 and newer", () => {
    expect(isSupportedNodeVersion("v24.0.0")).toBe(true);
    expect(isSupportedNodeVersion("v25.1.0")).toBe(true);
  });

  it("formats safe human and JSON unsupported-node errors", () => {
    expect(formatUnsupportedNodeError("v20.17.0", false)).toBe(
      "Error: Matrix CLI requires Node.js 24 or newer (current: v20.17.0).",
    );
    expect(JSON.parse(formatUnsupportedNodeError("v20.17.0", true))).toEqual({
      v: 1,
      error: {
        code: "unsupported_node",
        message: "Matrix CLI requires Node.js 24 or newer (current: v20.17.0).",
      },
    });
  });
});
