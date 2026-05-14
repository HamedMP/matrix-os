import { describe, expect, it } from "vitest";
import {
  assertRuntimeRequestMatchesPolicy,
  assertSafeBrowserUrl,
  assertSafeBrowserWebSocketUrl,
  createBrowserNavigationPolicy,
  createChromiumHostResolverRules,
} from "../../packages/mcp-browser/src/security.js";

const resolver = (addresses: string[]) => async () => addresses;

describe("Browser URL policy", () => {
  it("allows public http and https targets after DNS verification", async () => {
    await expect(assertSafeBrowserUrl("https://example.com/path", {
      resolveHostname: resolver(["93.184.216.34"]),
    })).resolves.toBe("https://example.com/path");
  });

  it("rejects IPv4 private, loopback, link-local, documentation, and multicast ranges", async () => {
    for (const address of ["10.0.0.1", "127.0.0.1", "169.254.1.1", "172.16.1.1", "192.168.1.1", "203.0.113.10", "224.0.0.1"]) {
      await expect(assertSafeBrowserUrl(`http://${address}/`)).rejects.toThrow("not allowed");
    }
  });

  it("rejects IPv6 loopback, unique-local, link-local, documentation, multicast, and mapped private ranges", async () => {
    for (const address of ["[::1]", "[fc00::1]", "[fd00::1]", "[fe80::1]", "[2001:db8::1]", "[ff02::1]", "[::ffff:127.0.0.1]", "[2001:0000:c000:0204:0000:0000:3f57:fefe]"]) {
      await expect(assertSafeBrowserUrl(`http://${address}/`)).rejects.toThrow("not allowed");
    }
  });

  it("rejects Matrix-local hostnames before DNS lookup", async () => {
    await expect(assertSafeBrowserUrl("https://localhost/")).rejects.toThrow("not allowed");
    await expect(assertSafeBrowserUrl("https://gateway.internal/")).rejects.toThrow("not allowed");
    await expect(assertSafeBrowserUrl("https://service.local/")).rejects.toThrow("not allowed");
  });

  it("pins the runtime request to the navigation policy address set", async () => {
    const policy = await createBrowserNavigationPolicy("https://example.com/start", {
      resolveHostname: resolver(["93.184.216.34"]),
      now: 1_000,
      ttlMs: 30_000,
    });

    await expect(assertRuntimeRequestMatchesPolicy("https://example.com/next", policy, {
      resolveHostname: resolver(["93.184.216.34"]),
      now: 2_000,
    })).resolves.toBe("https://example.com/next");

    await expect(assertRuntimeRequestMatchesPolicy("https://example.com/next", policy, {
      resolveHostname: resolver(["10.0.0.2"]),
      now: 2_000,
    })).rejects.toThrow("not allowed");
  });

  it("allows third-party public subresources while still blocking private destinations", async () => {
    const policy = await createBrowserNavigationPolicy("https://example.com/start", {
      resolveHostname: async (hostname) => hostname === "example.com" ? ["93.184.216.34"] : ["142.250.190.78"],
      now: 1_000,
      ttlMs: 30_000,
    });

    await expect(assertRuntimeRequestMatchesPolicy("https://cdn.example.net/app.css", policy, {
      resolveHostname: resolver(["142.250.190.78"]),
      now: 2_000,
    })).resolves.toBe("https://cdn.example.net/app.css");

    await expect(assertRuntimeRequestMatchesPolicy("https://internal.example/secret.js", policy, {
      resolveHostname: resolver(["10.0.0.2"]),
      now: 2_000,
    })).rejects.toThrow("not allowed");
  });

  it("rejects expired navigation policy bindings", async () => {
    const policy = await createBrowserNavigationPolicy("https://example.com/", {
      resolveHostname: resolver(["93.184.216.34"]),
      now: 1_000,
      ttlMs: 1_000,
    });

    await expect(assertRuntimeRequestMatchesPolicy("https://example.com/", policy, {
      resolveHostname: resolver(["93.184.216.34"]),
      now: 3_000,
    })).rejects.toThrow("could not be verified");
  });

  it("creates a single Chromium resolver pinning rule for DNS-bound hostnames", async () => {
    const policy = await createBrowserNavigationPolicy("https://example.com/", {
      resolveHostname: resolver(["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34", "93.184.216.35"]),
    });

    expect(createChromiumHostResolverRules(policy)).toEqual([
      "MAP example.com 93.184.216.34",
    ]);
  });

  it("brackets IPv6-only Chromium resolver pinning addresses", async () => {
    const policy = await createBrowserNavigationPolicy("https://example.com/", {
      resolveHostname: resolver(["2606:2800:220:1:248:1893:25c8:1946"]),
    });

    expect(createChromiumHostResolverRules(policy)).toEqual([
      "MAP example.com [2606:2800:220:1:248:1893:25c8:1946]",
    ]);
  });

  it("uses a separate allowlist for WebSocket URLs", async () => {
    await expect(assertSafeBrowserWebSocketUrl("wss://example.com/socket", {
      resolveHostname: resolver(["93.184.216.34"]),
    })).resolves.toBe("wss://example.com/socket");

    await expect(assertSafeBrowserWebSocketUrl("https://example.com/socket", {
      resolveHostname: resolver(["93.184.216.34"]),
    })).rejects.toThrow("ws or wss");
  });
});
