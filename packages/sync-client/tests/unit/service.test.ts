import { describe, expect, it } from "vitest";
import { escapeXml } from "../../src/daemon/service.js";

describe("escapeXml", () => {
  it("escapes launchd XML metacharacters in interpolated paths", () => {
    expect(escapeXml(`bad<&>"'path`)).toBe(
      "bad&lt;&amp;&gt;&quot;&apos;path",
    );
  });
});
