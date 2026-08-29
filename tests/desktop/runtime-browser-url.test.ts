import { describe, expect, it } from "vitest";
import {
  resolveBrowserAddress,
  resolveRuntimeBrowserNavigation,
} from "@desktop/shared/runtime-browser-url";

describe("desktop browser address routing", () => {
  it("keeps loopback ports on the selected Matrix runtime", () => {
    expect(resolveBrowserAddress("127.0.0.1:3000/docs?q=matrix#api")).toEqual({
      disposition: "runtime",
      url: "http://127.0.0.1:3000/docs?q=matrix#api",
      remoteHost: "127.0.0.1",
      remotePort: 3000,
    });
    expect(resolveBrowserAddress("http://localhost:5173/")).toEqual({
      disposition: "runtime",
      url: "http://localhost:5173/",
      remoteHost: "localhost",
      remotePort: 5173,
    });
  });

  it("opens public web addresses in local Chromium", () => {
    expect(resolveBrowserAddress("docs.matrix-os.com")).toEqual({
      disposition: "external",
      url: "https://docs.matrix-os.com/",
    });
    expect(resolveBrowserAddress("https://developer.mozilla.org/en-US/")).toEqual({
      disposition: "external",
      url: "https://developer.mozilla.org/en-US/",
    });
  });

  it("turns free text into a local-browser web search", () => {
    expect(resolveBrowserAddress("Matrix OS docs")).toEqual({
      disposition: "external",
      url: "https://www.google.com/search?q=Matrix+OS+docs",
    });
  });

  it("rejects unsafe schemes, credentials, and loopback addresses without an explicit port", () => {
    expect(resolveBrowserAddress("file:///etc/passwd")).toBeNull();
    expect(resolveBrowserAddress("https://user:pass@example.com")).toBeNull();
    expect(resolveBrowserAddress("localhost")).toBeNull();
    expect(resolveBrowserAddress("127.0.0.1")).toBeNull();
  });

  it("never opens another IPv4 loopback address on the local computer", () => {
    expect(resolveBrowserAddress("127.0.0.2:4000/private")).toBeNull();
    expect(resolveBrowserAddress("http://127.255.255.254:4000/private")).toBeNull();
    expect(resolveRuntimeBrowserNavigation(
      "http://127.0.0.2:4000/private",
      4000,
      "http://127.0.0.1:49152",
    )).toEqual({ disposition: "block" });
  });

  it("rewrites canonical same-port loopback navigation through the active tunnel", () => {
    expect(resolveRuntimeBrowserNavigation(
      "http://localhost:3000/callback?code=ok#done",
      3000,
      "http://127.0.0.1:49152",
    )).toEqual({
      disposition: "rewrite",
      url: "http://127.0.0.1:49152/callback?code=ok#done",
    });
    expect(resolveRuntimeBrowserNavigation(
      "http://127.0.0.1:4000/other",
      3000,
      "http://127.0.0.1:49152",
    )).toEqual({ disposition: "block" });
    expect(resolveRuntimeBrowserNavigation(
      "https://matrix-os.com/docs",
      3000,
      "http://127.0.0.1:49152",
    )).toEqual({ disposition: "external" });
  });
});
