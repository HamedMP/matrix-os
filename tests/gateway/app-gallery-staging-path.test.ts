import { describe, expect, it } from "vitest";
import { containsDeniedFileApiPath, isDeniedFileApiPath } from "../../packages/gateway/src/path-security";

describe("private gallery installation staging", () => {
  it("blocks workspace grants and ordinary file APIs from exposing staging", () => {
    const home = "/owner/home";
    expect(isDeniedFileApiPath(home, "data/app-gallery-staging")).toBe(true);
    expect(isDeniedFileApiPath(home, "data/app-gallery-staging/pending/index.html")).toBe(true);
    expect(containsDeniedFileApiPath(home, "/owner/home/data")).toBe(true);
    expect(containsDeniedFileApiPath(home, "/owner/home/data/app-gallery-staging")).toBe(true);
    expect(isDeniedFileApiPath(home, "data/app-gallery-staging-not-private")).toBe(false);
    expect(isDeniedFileApiPath(home, "apps/folio/index.html")).toBe(false);
  });
});
