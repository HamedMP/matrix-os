import { describe, expect, it } from "vitest";
import {
  getConfiguredAppOrigin,
  getPublicOrigin,
} from "../../shell/src/lib/public-origin";

function requestLike(input: {
  headers?: Record<string, string>;
  host?: string;
  protocol?: string;
}) {
  const headers = new Headers(input.headers ?? {});
  return {
    headers,
    nextUrl: {
      host: input.host ?? "localhost:3200",
      protocol: input.protocol ?? "http:",
    },
  };
}

describe("getConfiguredAppOrigin", () => {
  it("returns the origin of a configured app URL", () => {
    expect(getConfiguredAppOrigin("https://app.matrix-os.com")).toBe(
      "https://app.matrix-os.com",
    );
    expect(getConfiguredAppOrigin("https://app.matrix-os.com/some/path")).toBe(
      "https://app.matrix-os.com",
    );
  });

  it("returns null when the app URL is missing or unparsable", () => {
    expect(getConfiguredAppOrigin(undefined)).toBeNull();
    expect(getConfiguredAppOrigin("")).toBeNull();
    expect(getConfiguredAppOrigin("not a url")).toBeNull();
  });
});

describe("getPublicOrigin", () => {
  it("prefers the configured app origin over forwarded headers", () => {
    const request = requestLike({
      headers: {
        "x-forwarded-host": "app.matrix-os.com",
        "x-forwarded-proto": "http",
        host: "127.0.0.1:3200",
      },
    });

    expect(getPublicOrigin(request, "https://app.matrix-os.com")).toBe(
      "https://app.matrix-os.com",
    );
  });

  it("never leaks the internal auth shell origin when the app URL is configured", () => {
    const request = requestLike({
      headers: { host: "localhost:3200" },
      host: "localhost:3200",
      protocol: "http:",
    });

    const origin = getPublicOrigin(request, "https://app.matrix-os.com");
    expect(origin).toBe("https://app.matrix-os.com");
    expect(origin).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it("falls back to forwarded headers when no app URL is configured", () => {
    const request = requestLike({
      headers: {
        "x-forwarded-host": "app.example.test",
        "x-forwarded-proto": "https",
        host: "127.0.0.1:3200",
      },
    });

    expect(getPublicOrigin(request, undefined)).toBe("https://app.example.test");
  });

  it("falls back to the host header, then nextUrl, in local dev", () => {
    expect(
      getPublicOrigin(
        requestLike({ headers: { host: "localhost:3000" }, protocol: "http:" }),
        undefined,
      ),
    ).toBe("http://localhost:3000");
    expect(
      getPublicOrigin(
        requestLike({ host: "localhost:3000", protocol: "http:" }),
        undefined,
      ),
    ).toBe("http://localhost:3000");
  });

  it("ignores an unparsable configured app URL and uses the header chain", () => {
    const request = requestLike({
      headers: {
        "x-forwarded-host": "app.matrix-os.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(getPublicOrigin(request, "not a url")).toBe(
      "https://app.matrix-os.com",
    );
  });

  it("builds sign-in redirect URLs with the public https origin", () => {
    const request = requestLike({
      headers: {
        host: "127.0.0.1:3200",
        "x-forwarded-host": "app.matrix-os.com",
        "x-forwarded-proto": "http",
      },
    });
    const publicOrigin = getPublicOrigin(request, "https://app.matrix-os.com");
    const signInUrl = new URL("/sign-in", publicOrigin);
    signInUrl.searchParams.set(
      "redirect_url",
      new URL("/", publicOrigin).toString(),
    );

    expect(signInUrl.toString()).toBe(
      "https://app.matrix-os.com/sign-in?redirect_url=https%3A%2F%2Fapp.matrix-os.com%2F",
    );
  });
});
