import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMcpProfileContext,
  resolveRuntimeSelectionOrigin,
  runtimeApiUrl,
} from "../../src/mcp/profile-context.js";

const tempDirs: string[] = [];

async function profileFixture(input: { expiresAt?: number; runtimeSlot?: string } = {}) {
  const configDir = await mkdtemp(join(tmpdir(), "matrix-mcp-profile-"));
  tempDirs.push(configDir);
  await mkdir(join(configDir, "profiles", "cloud"), { recursive: true });
  await writeFile(join(configDir, "profiles.json"), JSON.stringify({
    active: "cloud",
    profiles: {
      cloud: {
        platformUrl: "https://app.matrix-os.com",
        gatewayUrl: "https://app.matrix-os.com",
      },
    },
  }));
  await writeFile(join(configDir, "profiles", "cloud", "auth.json"), JSON.stringify({
    accessToken: "owner-token",
    expiresAt: input.expiresAt ?? Date.now() + 60_000,
    userId: "user_123",
    handle: "neo",
    runtimeSlot: input.runtimeSlot ?? "primary",
  }));
  return configDir;
}

function computer(runtimeSlot = "primary", availability = "available") {
  const handle = runtimeSlot === "primary" ? "neo" : `neo-${runtimeSlot}`;
  return {
    handle,
    runtimeSlot,
    label: runtimeSlot === "primary" ? "Main Computer" : "Additional Computer",
    availability,
    kind: "customer",
    versionLabel: "stable",
    gatewayPath: runtimeSlot === "primary" ? `/vm/${handle}` : `/vm/${handle}?runtime=${runtimeSlot}`,
    capabilities: ["terminal"],
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Matrix MCP profile context", () => {
  it("maps the production app origin to the control-plane origin", () => {
    expect(resolveRuntimeSelectionOrigin("https://app.matrix-os.com")).toBe("https://api.matrix-os.com");
    expect(resolveRuntimeSelectionOrigin("http://localhost:9000/")).toBe("http://localhost:9000");
    expect(resolveRuntimeSelectionOrigin("https://app.matrix-os.com", "https://control.example/")).toBe("https://control.example");
    expect(() => resolveRuntimeSelectionOrigin("http://matrix.example"))
      .toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("preserves the selected runtime query while appending a fixed API path", () => {
    expect(runtimeApiUrl(
      "https://app.matrix-os.com/vm/neo-review?runtime=review",
      "/api/terminal/sessions/main/tabs",
    )).toBe("https://app.matrix-os.com/vm/neo-review/api/terminal/sessions/main/tabs?runtime=review");
    expect(() => runtimeApiUrl("http://matrix.example", "/api/terminal/sessions"))
      .toThrow(expect.objectContaining({ code: "invalid_input" }));
  });

  it("lists only a validated owner inventory using the stored profile token", async () => {
    const configDir = await profileFixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      items: [computer()],
      selectedSlot: "primary",
      hasMore: false,
      limit: 20,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const context = createMcpProfileContext({ configDir, fetch: fetcher });
    await expect(context.listComputers()).resolves.toMatchObject({ selectedSlot: "primary" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://app.matrix-os.com/api/auth/computers",
      expect.objectContaining({
        headers: { Authorization: "Bearer owner-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("fails closed before a request when profile auth is expired", async () => {
    const configDir = await profileFixture({ expiresAt: Date.now() - 1 });
    const fetcher = vi.fn<typeof fetch>();
    const context = createMcpProfileContext({ configDir, fetch: fetcher });

    await expect(context.listComputers()).rejects.toMatchObject({ code: "auth_required" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unavailable and unknown computers without selecting them", async () => {
    const configDir = await profileFixture();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      items: [computer("primary", "unavailable")],
      selectedSlot: "primary",
      hasMore: false,
      limit: 20,
    }), { status: 200 }));
    const context = createMcpProfileContext({ configDir, fetch: fetcher });

    await expect(context.resolveRuntime("primary")).rejects.toMatchObject({ code: "computer_unavailable" });
    await expect(context.resolveRuntime("review")).rejects.toMatchObject({ code: "computer_not_found" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("mints an in-memory token for a non-default computer without changing profile auth", async () => {
    const configDir = await profileFixture();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/auth/computers")) {
        return new Response(JSON.stringify({
          items: [computer(), computer("review")],
          selectedSlot: "primary",
          hasMore: false,
          limit: 20,
        }), { status: 200 });
      }
      expect(url).toBe("https://api.matrix-os.com/api/auth/runtime-selection");
      expect(init).toMatchObject({
        method: "POST",
        headers: {
          Authorization: "Bearer owner-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slot: "review" }),
      });
      return new Response(JSON.stringify({
        accessToken: "r".repeat(32),
        expiresAt: Date.now() + 60_000,
        handle: "neo-review",
        slot: "review",
      }), { status: 200 });
    });
    const context = createMcpProfileContext({ configDir, fetch: fetcher });

    await expect(context.resolveRuntime("review")).resolves.toMatchObject({
      token: "r".repeat(32),
      gatewayUrl: "https://app.matrix-os.com/vm/neo-review?runtime=review",
      computer: { runtimeSlot: "review", handle: "neo-review" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects an inventory whose selected slot is not present", async () => {
    const configDir = await profileFixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      items: [computer("review")],
      selectedSlot: "primary",
      hasMore: false,
      limit: 20,
    }), { status: 200 }));
    const context = createMcpProfileContext({ configDir, fetch: fetcher });

    await expect(context.listComputers()).rejects.toMatchObject({ code: "request_failed" });
  });

  it("rejects an expired token minted for another computer", async () => {
    const configDir = await profileFixture();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/api/auth/computers")) {
        return new Response(JSON.stringify({
          items: [computer(), computer("review")],
          selectedSlot: "primary",
          hasMore: false,
          limit: 20,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        accessToken: "r".repeat(32),
        expiresAt: Date.now() - 1,
        handle: "neo-review",
        slot: "review",
      }), { status: 200 });
    });
    const context = createMcpProfileContext({ configDir, fetch: fetcher });

    await expect(context.resolveRuntime("review")).rejects.toMatchObject({ code: "request_failed" });
  });
});
