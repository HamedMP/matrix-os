import { describe, expect, it } from "vitest";
import { desktopSafeErrorMessage, safeDesktopClientError } from "../../shell/src/lib/desktop-runtime.js";

describe("desktop safe errors", () => {
  it("allowlists short product errors and masks provider/path/database details", () => {
    expect(desktopSafeErrorMessage(new Error("Desktop runtime unavailable"))).toBe("Desktop runtime unavailable");
    expect(desktopSafeErrorMessage(new Error("Linear token failed at /Users/homedb/postgres"))).toBe("Request failed");
    expect(safeDesktopClientError(new Error("secret key leaked"))).toBe("Request failed");
  });
});
