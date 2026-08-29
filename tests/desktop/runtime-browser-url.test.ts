import { describe, expect, it } from "vitest";
import { resolveBrowserAddress } from "@desktop/shared/runtime-browser-url";

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
});
