import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve4, resolve6 } from "node:dns/promises";
import {
  isPrivateIp,
  isBlockedHostname,
  validateUrl,
  SsrfBlockedError,
} from "../../packages/kernel/src/security/ssrf-guard.js";

vi.mock("node:dns/promises", () => ({ resolve4: vi.fn(), resolve6: vi.fn() }));

beforeEach(() => {
  vi.mocked(resolve4).mockReset().mockResolvedValue(["93.184.216.34"]);
  vi.mocked(resolve6).mockReset().mockResolvedValue([]);
});

const blockedIpv4 = [
  "0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254",
  "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1",
  "100.127.255.255", "192.0.0.1", "192.0.0.8", "192.0.0.11", "192.0.2.1", "198.18.0.1",
  "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1",
  "239.255.255.255", "240.0.0.1", "255.255.255.255",
];

function mappedIpv4Forms(ip: string): string[] {
  const octets = ip.split(".").map(Number);
  const high = ((octets[0] << 8) | octets[1]).toString(16);
  const low = ((octets[2] << 8) | octets[3]).toString(16);
  return [
    `::ffff:${ip}`, `::ffff:${high}:${low}`,
    `0::ffff:${ip}`, `0:0::ffff:${high}:${low}`, `0:0:0:0::ffff:${high}:${low}`,
    `0:0:0:0:0:ffff:${ip}`, `0:0:0:0:0:ffff:${high}:${low}`,
    `0000:0000:0000:0000:0000:FFFF:${high.padStart(4, "0")}:${low.padStart(4, "0")}`,
  ];
}

describe("isPrivateIp", () => {
  it.each(blockedIpv4)("blocks special IPv4 ranges and all mapped forms of %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
    for (const mapped of mappedIpv4Forms(ip)) {
      expect(isPrivateIp(mapped), mapped).toBe(true);
      expect(isPrivateIp(`[${mapped}]`), `[${mapped}]`).toBe(true);
    }
  });

  it.each([
    "::", "0:0:0:0:0:0:0:0", "0:0:0:0:0:0:0:1",
    "::127.0.0.1", "::7f00:1", "0:0:0:0:0:0:7f00:1",
    "fe90::1", "fea0::1", "febf:ffff::1", "fec1::1", "feff::1",
    "ff02::1", "2001:db8::1", "2001:0DB8:0:0:0:0:0:1",
    "fe80::1%eth0",
  ])("blocks special IPv6 address %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each([
    "100.63.255.255", "100.128.0.0", "192.0.0.9", "192.0.0.10", "192.0.1.1", "192.0.3.1",
    "198.17.255.255", "198.20.0.0", "198.51.99.255", "198.51.101.0",
    "203.0.112.255", "203.0.114.0", "223.255.255.255", "8.8.8.8",
  ])("allows public IPv4 and its mapped forms: %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
    for (const mapped of mappedIpv4Forms(ip)) expect(isPrivateIp(mapped), mapped).toBe(false);
  });

  it.each([
    "::192.0.0.9", "::c000:9", "0:0:0:0:0:0:c000:9",
    "::192.0.0.10", "::c000:a", "0:0:0:0:0:0:c000:a",
  ])("allows IPv4-compatible public anycast address %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  it.each(["2001:db7::1", "2001:db9::1", "fe7f::1", "fbff::1", "::808:808"])(
    "allows public IPv6 boundary %s", (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );

  it.each(["example.com", "10.example.com", "fc.example.com", "::ffff:gggg:1", "[::1", "127.0.0.999"])(
    "does not misclassify non-IP input %s", (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );
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
    expect(isPrivateIp("[::1]")).toBe(true);
  });

  it("blocks fe80:: (IPv6 link-local)", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("fe80::abc:def")).toBe(true);
  });

  it("blocks fc/fd (IPv6 unique local)", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd12::1")).toBe(true);
    expect(isPrivateIp("[fd12::1]")).toBe(true);
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
  it.each(blockedIpv4)("blocks URL-normalized mapped IPv4 %s before DNS", async (ip) => {
    for (const mapped of mappedIpv4Forms(ip)) {
      await expect(validateUrl(`http://[${mapped}]/secret`)).rejects.toThrow(SsrfBlockedError);
    }
    expect(resolve4).not.toHaveBeenCalled();
    expect(resolve6).not.toHaveBeenCalled();
  });

  it("checks the hexadecimal hostname produced by URL normalization", async () => {
    const url = "http://[::ffff:127.0.0.1]/secret";
    expect(new URL(url).hostname).toBe("[::ffff:7f00:1]");
    await expect(validateUrl(url)).rejects.toThrow(SsrfBlockedError);
  });

  it.each(["::ffff:7f00:1", "0:0:0:0:0:ffff:a9fe:a9fe", "2001:0db8:0:0:0:0:0:1"])(
    "blocks hostname resolving to special AAAA address %s", async (ip) => {
      vi.mocked(resolve6).mockResolvedValue(["2001:4860:4860::8888", ip]);
      await expect(validateUrl("https://example.com/data")).rejects.toThrow(SsrfBlockedError);
    },
  );

  it("blocks a special address among public A records", async () => {
    vi.mocked(resolve4).mockResolvedValue(["8.8.8.8", "198.51.100.1"]);
    await expect(validateUrl("https://example.com/data")).rejects.toThrow(SsrfBlockedError);
  });

  it.each(["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/"])(
    "blocks alternate IPv4 URL spelling %s", async (url) => {
      await expect(validateUrl(url)).rejects.toThrow(SsrfBlockedError);
    },
  );

  it("preserves exact private-IP allowlist exceptions", async () => {
    await expect(validateUrl("http://[::ffff:127.0.0.1]/admin", {
      allowedHostnames: ["[::ffff:7f00:1]"],
    })).resolves.toBeUndefined();
    await expect(validateUrl("http://10.0.0.1/admin", {
      allowedHostnames: ["10.0.0.1"],
    })).resolves.toBeUndefined();
    expect(resolve4).not.toHaveBeenCalled();
    expect(resolve6).not.toHaveBeenCalled();
  });

  it("does not let an unrelated allowlist bypass private literals", async () => {
    await expect(validateUrl("http://[::ffff:127.0.0.1]/admin", {
      allowedHostnames: ["*.example.com"],
    })).rejects.toThrow(SsrfBlockedError);
  });

  it.each(mappedIpv4Forms("8.8.8.8"))("allows mapped public URL %s", async (ip) => {
    await expect(validateUrl(`http://[${ip}]/data`)).resolves.toBeUndefined();
  });
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

  it("throws for bracketed private IPv6 literals in URLs", async () => {
    await expect(
      validateUrl("http://[::1]/admin")
    ).rejects.toThrow(SsrfBlockedError);
    await expect(
      validateUrl("http://[fd12::1]/admin")
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
