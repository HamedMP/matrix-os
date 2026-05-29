import { afterEach, describe, expect, it, vi } from "vitest";
import { createTuiSafeError } from "../../src/cli/tui/errors.js";
import { aggregateTuiStatusSnapshot } from "../../src/cli/tui/status.js";

describe("TUI status aggregation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds a healthy snapshot from profile, auth, gateway, daemon, and sessions", async () => {
    const snapshot = await aggregateTuiStatusSnapshot({
      now: () => new Date("2026-05-28T12:00:00Z"),
      resolveProfile: async () => ({ name: "cloud", gatewayUrl: "https://app.matrix-os.com", platformUrl: "https://app.matrix-os.com" }),
      loadAuth: async () => ({ authenticated: true, expired: false, handle: "nim" }),
      checkGateway: async () => ({ state: "healthy", label: "ok" }),
      checkDaemon: async () => ({ state: "healthy", label: "running" }),
      listShellSessions: async () => [{ name: "main" }, { name: "agent" }],
    });

    expect(snapshot.overall).toBe("healthy");
    expect(snapshot.profile.name).toBe("cloud");
    expect(snapshot.auth.state).toBe("authenticated");
    expect(snapshot.sessions.count).toBe(2);
    expect(snapshot.refreshedAt).toBe("2026-05-28T12:00:00.000Z");
  });

  it("prioritizes logged-out state when auth is missing", async () => {
    const snapshot = await aggregateTuiStatusSnapshot({
      resolveProfile: async () => ({ name: "cloud", gatewayUrl: "https://app.matrix-os.com", platformUrl: "https://app.matrix-os.com" }),
      loadAuth: async () => ({ authenticated: false, expired: false }),
      checkGateway: async () => ({ state: "healthy", label: "ok" }),
      checkDaemon: async () => ({ state: "healthy", label: "running" }),
      listShellSessions: async () => [],
    });

    expect(snapshot.overall).toBe("unauthenticated");
    expect(snapshot.blockingActions).toContain("login");
  });

  it("keeps partial failures degraded instead of throwing", async () => {
    const snapshot = await aggregateTuiStatusSnapshot({
      resolveProfile: async () => ({ name: "cloud", gatewayUrl: "https://app.matrix-os.com", platformUrl: "https://app.matrix-os.com" }),
      loadAuth: async () => ({ authenticated: true, expired: false, handle: "nim" }),
      checkGateway: async () => { throw new Error("postgres://secret"); },
      checkDaemon: async () => ({ state: "healthy", label: "running" }),
      listShellSessions: async () => { throw new Error("/Users/private"); },
    });

    expect(snapshot.overall).toBe("degraded");
    expect(snapshot.gateway.state).toBe("degraded");
    expect(snapshot.safeError?.message).toBe("Request failed");
  });

  it("starts gateway, daemon, and session checks concurrently", async () => {
    const started: string[] = [];
    let releaseGateway!: () => void;
    const gatewayGate = new Promise<void>((resolve) => { releaseGateway = resolve; });

    const snapshotPromise = aggregateTuiStatusSnapshot({
      resolveProfile: async () => ({ name: "cloud", gatewayUrl: "https://app.matrix-os.com", platformUrl: "https://app.matrix-os.com" }),
      loadAuth: async () => ({ authenticated: true, expired: false, handle: "nim" }),
      checkGateway: async () => {
        started.push("gateway");
        await gatewayGate;
        return { state: "healthy", label: "ok" };
      },
      checkDaemon: async () => {
        started.push("daemon");
        return { state: "healthy", label: "running" };
      },
      listShellSessions: async () => {
        started.push("sessions");
        return [];
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    const startedBeforeGatewayResolved = [...started];
    releaseGateway();

    await expect(snapshotPromise).resolves.toMatchObject({ overall: "healthy" });
    expect(startedBeforeGatewayResolved).toEqual(["gateway", "daemon", "sessions"]);
  });

  it("degrades instead of reporting healthy when a subsystem remains unknown", async () => {
    const snapshot = await aggregateTuiStatusSnapshot({
      resolveProfile: async () => ({ name: "cloud", gatewayUrl: "https://app.matrix-os.com", platformUrl: "https://app.matrix-os.com" }),
      loadAuth: async () => ({ authenticated: true, expired: false, handle: "nim" }),
      checkGateway: async () => ({ state: "unknown", label: "gateway unknown" }),
      checkDaemon: async () => ({ state: "healthy", label: "running" }),
      listShellSessions: async () => [],
    });

    expect(snapshot.overall).toBe("degraded");
  });

  it("blocks instead of reporting healthy when profile resolution fails", async () => {
    const profileError = createTuiSafeError("profile_not_found");
    const snapshot = await aggregateTuiStatusSnapshot({
      resolveProfile: async () => { throw profileError; },
      checkDaemon: async () => ({ state: "healthy", label: "running" }),
      listShellSessions: async () => [],
    });

    expect(snapshot.overall).toBe("blocked");
    expect(snapshot.auth.state).toBe("unknown");
    expect(snapshot.profile.state).toBe("unknown");
    expect(snapshot.blockingActions).toContain("profile");
  });

  it("preserves the first safe error as the root cause", async () => {
    const profileError = createTuiSafeError("profile_not_found");
    const timeoutError = createTuiSafeError("timeout");
    const snapshot = await aggregateTuiStatusSnapshot({
      resolveProfile: async () => { throw profileError; },
      checkGateway: async () => { throw timeoutError; },
      checkDaemon: async () => ({ state: "healthy", label: "running" }),
      listShellSessions: async () => [],
    });

    expect(snapshot.profile.state).toBe("unknown");
    expect(snapshot.gateway.state).toBe("degraded");
    expect(snapshot.safeError?.code).toBe("profile_not_found");
  });

  it("checks the gateway public health endpoint by default", async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ status: "ok" }), {
        status: String(url).endsWith("/health") ? 200 : 401,
        headers: { "content-type": "application/json" },
      });
    }));

    const snapshot = await aggregateTuiStatusSnapshot({
      resolveProfile: async () => ({
        name: "local",
        gatewayUrl: "http://localhost:4100",
        platformUrl: "http://localhost:9000",
        token: "dev-token",
      }),
      loadAuth: async () => ({ authenticated: true, expired: false, handle: "dev" }),
      checkDaemon: async () => ({ state: "healthy", label: "running" }),
      listShellSessions: async () => [],
    });

    expect(seenUrls).toContain("http://localhost:4100/health");
    expect(seenUrls).not.toContain("http://localhost:4100/api/health");
    expect(snapshot.gateway.state).toBe("healthy");
  });

});
