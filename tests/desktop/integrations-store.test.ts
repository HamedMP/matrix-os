// Unit tests for the desktop integrations store and its tolerant response
// parsers. The store talks to the VPS gateway proxy routes /api/integrations*
// (packages/gateway/src/integrations/routes.ts); the renderer never sees
// tokens — only display-safe fields (name, category, label, email, status).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_AVAILABLE_INTEGRATIONS,
  MAX_CONNECTED_INTEGRATIONS,
  parseAvailableIntegrations,
  parseConnectedIntegrations,
  parseConnectUrl,
  useIntegrations,
} from "../../desktop/src/renderer/src/features/integrations";
import { AppError } from "../../desktop/src/shared/app-error";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";

const AVAILABLE = [
  { id: "gmail", name: "Gmail", category: "google", icon: "mail", logoUrl: "https://x.test/g.png", actions: {} },
  { id: "slack", name: "Slack", category: "communication", icon: "chat", actions: {} },
];

const CONNECTIONS = [
  {
    id: "7d3f6f1e-2b3c-4a5d-8e9f-0a1b2c3d4e5f",
    service: "gmail",
    account_label: "Work",
    account_email: "work@example.com",
    scopes: ["mail"],
    status: "active",
    connected_at: "2026-06-01T00:00:00.000Z",
    last_used_at: null,
  },
];

function makeApi(overrides: Partial<Record<"get" | "post" | "delete", (path: string, body?: unknown) => Promise<unknown>>> = {}) {
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(overrides.get ?? (async (path: string) => {
      if (path === "/api/integrations/available") return AVAILABLE;
      if (path === "/api/integrations") return CONNECTIONS;
      throw new AppError("notFound");
    })),
    post: vi.fn(overrides.post ?? (async () => ({}))),
    delete: vi.fn(overrides.delete ?? (async () => ({ ok: true }))),
    patch: vi.fn(),
    put: vi.fn(),
    putText: vi.fn(),
    getText: vi.fn(),
    getBlob: vi.fn(),
  } as unknown as ApiClient;
}

describe("parseAvailableIntegrations", () => {
  it("parses the gateway array shape and keeps only display-safe fields", () => {
    const parsed = parseAvailableIntegrations(AVAILABLE);
    expect(parsed).toEqual([
      { id: "gmail", name: "Gmail", category: "google" },
      { id: "slack", name: "Slack", category: "communication" },
    ]);
  });

  it("accepts the { services: [...] } envelope the shell tolerates", () => {
    const parsed = parseAvailableIntegrations({ services: AVAILABLE });
    expect(parsed).toHaveLength(2);
  });

  it("drops malformed entries and falls back to the id as the name", () => {
    const parsed = parseAvailableIntegrations([
      { id: "github", category: "developer" },
      { name: "no-id" },
      "junk",
      null,
    ]);
    expect(parsed).toEqual([{ id: "github", name: "github", category: "developer" }]);
  });

  it("caps the catalog to a bounded size", () => {
    const huge = Array.from({ length: MAX_AVAILABLE_INTEGRATIONS + 50 }, (_, i) => ({
      id: `svc-${i}`,
      name: `Service ${i}`,
      category: "other",
    }));
    expect(parseAvailableIntegrations(huge)).toHaveLength(MAX_AVAILABLE_INTEGRATIONS);
  });

  it("returns an empty list for unusable payloads", () => {
    expect(parseAvailableIntegrations(undefined)).toEqual([]);
    expect(parseAvailableIntegrations({ nope: true })).toEqual([]);
  });
});

describe("parseConnectedIntegrations", () => {
  it("parses the gateway connection shape", () => {
    const parsed = parseConnectedIntegrations(CONNECTIONS);
    expect(parsed).toEqual([
      {
        id: "7d3f6f1e-2b3c-4a5d-8e9f-0a1b2c3d4e5f",
        service: "gmail",
        accountLabel: "Work",
        accountEmail: "work@example.com",
        status: "active",
        connectedAt: "2026-06-01T00:00:00.000Z",
      },
    ]);
  });

  it("accepts { connections: [...] } and sync's { services: [...] } envelopes", () => {
    expect(parseConnectedIntegrations({ connections: CONNECTIONS })).toHaveLength(1);
    expect(parseConnectedIntegrations({ synced: 1, services: CONNECTIONS })).toHaveLength(1);
  });

  it("drops entries without a usable id or service", () => {
    const parsed = parseConnectedIntegrations([
      ...CONNECTIONS,
      { id: "x" },
      { service: "slack" },
      { id: 42, service: "slack" },
    ]);
    expect(parsed).toHaveLength(1);
  });

  it("caps the connection list to a bounded size", () => {
    const huge = Array.from({ length: MAX_CONNECTED_INTEGRATIONS + 50 }, (_, i) => ({
      id: `7d3f6f1e-2b3c-4a5d-8e9f-${String(i).padStart(12, "0")}`,
      service: "gmail",
      account_label: `Account ${i}`,
      account_email: null,
      status: "active",
      connected_at: "2026-06-01T00:00:00.000Z",
    }));
    expect(parseConnectedIntegrations(huge)).toHaveLength(MAX_CONNECTED_INTEGRATIONS);
  });
});

describe("parseConnectUrl", () => {
  it("accepts an https connect URL from the gateway", () => {
    expect(parseConnectUrl({ url: "https://pipedream.com/connect?token=abc", service: "gmail" }))
      .toBe("https://pipedream.com/connect?token=abc");
  });

  it("rejects non-https URLs and malformed payloads", () => {
    expect(parseConnectUrl({ url: "http://insecure.test/connect" })).toBeNull();
    expect(parseConnectUrl({ url: "javascript:alert(1)" })).toBeNull();
    expect(parseConnectUrl({ url: 42 })).toBeNull();
    expect(parseConnectUrl(null)).toBeNull();
    expect(parseConnectUrl({})).toBeNull();
  });
});

describe("useIntegrations store", () => {
  beforeEach(() => {
    useIntegrations.setState(useIntegrations.getInitialState(), true);
    useConnection.setState({ api: null });
  });

  it("refresh() loads the catalog and connections through the ApiClient", async () => {
    const api = makeApi();
    await useIntegrations.getState().refresh(api);

    expect(useIntegrations.getState().status).toBe("ready");
    expect(useIntegrations.getState().available).toHaveLength(2);
    expect(useIntegrations.getState().connections).toHaveLength(1);
    expect(useIntegrations.getState().errorMessage).toBeNull();
    expect(api.get).toHaveBeenCalledWith("/api/integrations/available");
    expect(api.get).toHaveBeenCalledWith("/api/integrations");
  });

  it("refresh() falls back to the connection store's ApiClient when none is passed", async () => {
    const api = makeApi();
    useConnection.setState({ api });
    await useIntegrations.getState().refresh();

    expect(useIntegrations.getState().status).toBe("ready");
    expect(api.get).toHaveBeenCalledWith("/api/integrations/available");
  });

  it("reports a generic error when no runtime ApiClient is available", async () => {
    await useIntegrations.getState().refresh(null);
    expect(useIntegrations.getState().status).toBe("error");
    expect(useIntegrations.getState().errorMessage).toBeTruthy();
  });

  it("capability-gates on 404: marks integrations unavailable instead of erroring", async () => {
    const api = makeApi({
      get: async () => {
        throw new AppError("notFound");
      },
    });
    await useIntegrations.getState().refresh(api);

    expect(useIntegrations.getState().status).toBe("unavailable");
    expect(useIntegrations.getState().errorMessage).toBeNull();
    expect(useIntegrations.getState().available).toEqual([]);
    expect(useIntegrations.getState().connections).toEqual([]);
  });

  it("marks the store errored with generic copy on transport failures", async () => {
    const api = makeApi({
      get: async () => {
        throw new AppError("offline");
      },
    });
    await useIntegrations.getState().refresh(api);

    expect(useIntegrations.getState().status).toBe("error");
    // Generic display copy only — never the raw upstream error text.
    expect(useIntegrations.getState().errorMessage).toBe("Can't reach Matrix OS. Check your connection.");
  });

  it("syncNow() replaces connections with the Pipedream-side account list", async () => {
    const synced = [
      { ...CONNECTIONS[0], id: "8e4a7a2f-3c4d-5b6e-9f0a-1b2c3d4e5f60", account_label: "Personal" },
    ];
    const api = makeApi({
      post: async (path: string) => {
        if (path === "/api/integrations/sync") return { synced: 1, services: synced };
        throw new AppError("notFound");
      },
    });
    await useIntegrations.getState().refresh(api);

    const ok = await useIntegrations.getState().syncNow(api);
    expect(ok).toBe(true);
    expect(api.post).toHaveBeenCalledWith("/api/integrations/sync", {});
    expect(useIntegrations.getState().connections.map((c) => c.id)).toEqual(["8e4a7a2f-3c4d-5b6e-9f0a-1b2c3d4e5f60"]);
  });

  it("syncNow() returns false without throwing when the proxy fails", async () => {
    const api = makeApi({
      post: async () => {
        throw new AppError("server");
      },
    });
    const ok = await useIntegrations.getState().syncNow(api);
    expect(ok).toBe(false);
  });

  it("startConnect() posts the service id and returns the https connect URL", async () => {
    const api = makeApi({
      post: async (path: string) => {
        if (path === "/api/integrations/connect") {
          return { url: "https://pipedream.com/connect?token=abc", service: "gmail" };
        }
        throw new AppError("notFound");
      },
    });
    const url = await useIntegrations.getState().startConnect("gmail", api);
    expect(url).toBe("https://pipedream.com/connect?token=abc");
    expect(api.post).toHaveBeenCalledWith("/api/integrations/connect", { service: "gmail" });
  });

  it("startConnect() refuses non-https URLs and sets a generic error", async () => {
    const api = makeApi({
      post: async () => ({ url: "http://evil.test/connect" }),
    });
    const url = await useIntegrations.getState().startConnect("gmail", api);
    expect(url).toBeNull();
    expect(useIntegrations.getState().errorMessage).toBe("Something went wrong. Please try again.");
  });

  it("startConnect() surfaces only generic copy when the proxy fails", async () => {
    const api = makeApi({
      post: async () => {
        throw new Error("pipedream exploded: secret-token-leak");
      },
    });
    const url = await useIntegrations.getState().startConnect("gmail", api);
    expect(url).toBeNull();
    expect(useIntegrations.getState().errorMessage).toBe("Something went wrong. Please try again.");
  });

  it("disconnect() removes the connection on success", async () => {
    const api = makeApi();
    await useIntegrations.getState().refresh(api);

    const ok = await useIntegrations.getState().disconnect("7d3f6f1e-2b3c-4a5d-8e9f-0a1b2c3d4e5f", api);
    expect(ok).toBe(true);
    expect(api.delete).toHaveBeenCalledWith("/api/integrations/7d3f6f1e-2b3c-4a5d-8e9f-0a1b2c3d4e5f");
    expect(useIntegrations.getState().connections).toEqual([]);
  });

  it("disconnect() keeps the connection and reports generic copy on failure", async () => {
    const api = makeApi({
      delete: async () => {
        throw new AppError("server");
      },
    });
    await useIntegrations.getState().refresh(makeApi());

    const ok = await useIntegrations.getState().disconnect("7d3f6f1e-2b3c-4a5d-8e9f-0a1b2c3d4e5f", api);
    expect(ok).toBe(false);
    expect(useIntegrations.getState().connections).toHaveLength(1);
    expect(useIntegrations.getState().errorMessage).toBe("Something went wrong. Please try again.");
  });

  it("disconnect() rejects non-UUID ids without calling the proxy", async () => {
    const api = makeApi();
    const ok = await useIntegrations.getState().disconnect("../traversal", api);
    expect(ok).toBe(false);
    expect(api.delete).not.toHaveBeenCalled();
  });
});
