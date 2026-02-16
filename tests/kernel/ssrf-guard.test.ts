import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isPrivateIp,
  isBlockedHostname,
  validateUrl,
  SsrfBlockedError,
} from "../../packages/kernel/src/security/ssrf-guard.js";

describe("isPrivateIp", () => {
  it("blocks 127.0.0.1 (loopback)", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
  });

  it("blocks 127.x.x.x range", () => {
    expect(isPrivateIp("127.0.0.2")).toBe(true);
    expect(isPrivateIp("127.255.255.255")).toBe(true);
  });

  it("blocks 10.x (class A private)", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("10.255.255.255")).toBe(true);
  });

  it("blocks 172.16-31.x (class B private)", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
  });

  it("allows 172.15.x and 172.32.x (not private)", () => {
    expect(isPrivateIp("172.15.0.1")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });

  it("blocks 192.168.x (class C private)", () => {
    expect(isPrivateIp("192.168.0.1")).toBe(true);
    expect(isPrivateIp("192.168.255.255")).toBe(true);
  });

  it("blocks 169.254.x (link-local)", () => {
    expect(isPrivateIp("169.254.0.1")).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  it("blocks 0.0.0.0", () => {
    expect(isPrivateIp("0.0.0.0")).toBe(true);
  });

  it("blocks ::1 (IPv6 loopback)", () => {
    expect(isPrivateIp("::1")).toBe(true);
  });

  it("blocks fe80:: (IPv6 link-local)", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fe80::abc:def")).toBe(true);
  });

  it("blocks fc/fd (IPv6 unique local)", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd12::1")).toBe(true);
  });

  it("blocks ::ffff:127.0.0.1 (mapped IPv4)", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
  });

  it("blocks ::ffff:10.0.0.1 (mapped private IPv4)", () => {
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
  });

  it("blocks ::ffff:192.168.1.1 (mapped private IPv4)", () => {
    expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true);
  });

  it("allows public IPs", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
  });

  it("allows public IPv6", () => {
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
  });
});

describe("isBlockedHostname", () => {
  it("blocks localhost", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
  });

  it("blocks metadata.google.internal", () => {
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
  });

  it("blocks AWS metadata IP", () => {
    expect(isBlockedHostname("169.254.169.254")).toBe(true);
  });

  it("allows normal hostnames", () => {
    expect(isBlockedHostname("example.com")).toBe(false);
    expect(isBlockedHostname("api.anthropic.com")).toBe(false);
  });
});

describe("validateUrl", () => {
  it("throws SsrfBlockedError for blocked hostnames", async () => {
    await expect(
      validateUrl("http://localhost:8080/secret")
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("throws SsrfBlockedError for metadata endpoint", async () => {
    await expect(
      validateUrl("http://169.254.169.254/latest/meta-data/")
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("throws for private IPs in URL", async () => {
    await expect(
      validateUrl("http://10.0.0.1/admin")
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("allows public URLs", async () => {
    await expect(
      validateUrl("https://example.com")
    ).resolves.toBeUndefined();
  });

  it("allows whitelisted hostnames", async () => {
    await expect(
      validateUrl("http://localhost:4000/api", {
        allowedHostnames: ["localhost"],
      })
    ).resolves.toBeUndefined();
  });

  it("allows wildcard hostname matches", async () => {
    await expect(
      validateUrl("https://api.internal.example.com/data", {
        allowedHostnames: ["*.example.com"],
      })
    ).resolves.toBeUndefined();
  });

  it("throws for invalid URLs", async () => {
    await expect(validateUrl("not-a-url")).rejects.toThrow();
  });

  it("SsrfBlockedError is a distinct error type", async () => {
    try {
      await validateUrl("http://127.0.0.1/secret");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SsrfBlockedError);
      expect((err as SsrfBlockedError).url).toBe("http://127.0.0.1/secret");
    }
  });
});
