import { describe, expect, it, vi } from "vitest";
import {
  assertGitHubConfig,
  MAX_GITHUB_RESPONSE_BYTES,
  requestGitHub,
  requestGitHubJson,
} from "../../scripts/ci/github-actions-api.mjs";

describe("CI GitHub Actions API client", () => {
  it("rejects oversized or malformed credentials before constructing a request", () => {
    expect(() => assertGitHubConfig("HamedMP/matrix-os", "x".repeat(8193)))
      .toThrow("GitHub Actions configuration is invalid");
    expect(() => assertGitHubConfig("HamedMP/matrix-os/extra", "token"))
      .toThrow("GitHub Actions configuration is invalid");
  });

  it("bounds response bodies and keeps upstream details out of failures", async () => {
    await expect(
      requestGitHubJson("https://api.github.com/fixed", {
        token: "token",
        fetchImpl: vi.fn(async () => new Response(
          JSON.stringify({ data: "x".repeat(MAX_GITHUB_RESPONSE_BYTES) }),
          { status: 200 },
        )),
      }),
    ).rejects.toThrow("GitHub Actions API response is too large");

    const failure = await requestGitHub("https://api.github.com/fixed", {
      token: "token",
      fetchImpl: vi.fn(async () => new Response("provider secret", { status: 503 })),
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: "GitHub Actions API request failed" });
    expect(String(failure)).not.toContain("provider secret");
  });
});
