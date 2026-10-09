/**
 * The owner's integration accounts for the Company Brain sources (remote and local transports) and the late-bound
 * seams the gateway hands the brain before platform integrations exist. Fake fetch and database; no network.
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrainIntegrationAccountsError, createBrainIntegrationAccounts, createBrainLateBoundIntegrations,
} from "../../packages/gateway/src/brain/sources/integration/index.js";
import { fakeFetch, jsonResponse } from "./helpers/brain-integration-fetch.js";

const BASE = "https://platform.test/internal/containers/alice/integrations";
const MACHINE = "machine-token";
const USER_ID = "0b6c5d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e";
const listed = (...pairs: [string, string][]) => jsonResponse(pairs.map(([service, account_label]) => ({ id: "c", service, account_label })));

function platformDb(connections: { service: string; account_label: string }[]) {
  const user = { id: USER_ID, clerk_id: "user_2abc", pipedream_external_id: "ext_1" };
  return {
    getUserByClerkId: vi.fn(async (clerkId: string) => (clerkId === user.clerk_id ? user : null)),
    getUserById: vi.fn(async (id: string) => (id === USER_ID ? user : null)),
    listConnectedServices: vi.fn(async (id: string) => (id === USER_ID ? connections : [])),
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("integration accounts", () => {
  it("reads the owner's labels of one service from the platform with the delegation headers", async () => {
    const fake = fakeFetch([listed(["github", "work"], ["linear", "l"], ["github", "home"], ["github", "work"], ["github", " bad "])]);
    const accounts = createBrainIntegrationAccounts({ internalBaseUrl: `${BASE}/`, machineToken: MACHINE, fetch: fake.fetch });
    expect(await accounts.accounts("owner_a", "github")).toEqual(["work", "home"]);
    expect(fake.calls[0]!.url).toBe(BASE);
    expect(fake.calls[0]!.init).toMatchObject({ redirect: "error" });
    expect(fake.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(fake.calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${MACHINE}`);
    expect(headers.get("x-platform-verified")).toBe(createHmac("sha256", MACHINE).update("owner_a").digest("hex"));
  });

  it("reads the local platform database for the user behind the owner id", async () => {
    const db = platformDb([{ service: "linear", account_label: "eng" }, { service: "github", account_label: "work" }]);
    const accounts = createBrainIntegrationAccounts({ db: db as never, pipedream: {} as never });
    expect(await accounts.accounts("user_2abc", "linear")).toEqual(["eng"]);
    expect(await accounts.isConnected("user_2abc", "github")).toBe(true);
    expect(await accounts.isConnected("user_2abc", "google_drive")).toBe(false);
    expect(await accounts.accounts("default", "linear")).toEqual([]);
    expect(db.getUserById).not.toHaveBeenCalled();
    expect(await accounts.accounts(USER_ID, "linear")).toEqual(["eng"]);
  });

  it("reads the dev principal's connections under the Clerk id the Settings connect flow stores (MATRIX_HANDLE)", async () => {
    const dev = { id: USER_ID, clerk_id: "dev", pipedream_external_id: "dev" };
    const db = {
      getUserByClerkId: vi.fn(async (clerkId: string) => (clerkId === "dev" ? dev : null)),
      getUserById: vi.fn(async () => null),
      listConnectedServices: vi.fn(async (id: string) => (id === USER_ID ? [{ service: "github", account_label: "work" }] : [])),
    };
    const accounts = createBrainIntegrationAccounts({
      db: db as never, pipedream: {} as never, env: { NODE_ENV: "development", MATRIX_HANDLE: "dev" },
    });
    expect(await accounts.accounts("default", "github")).toEqual(["work"]);
    expect(db.getUserByClerkId).toHaveBeenCalledWith("dev");
    // The clerk id wins over the handle, as in the connect flow; production never maps the dev principal.
    const clerk = createBrainIntegrationAccounts({
      db: db as never, pipedream: {} as never, env: { NODE_ENV: "development", MATRIX_HANDLE: "x", MATRIX_CLERK_USER_ID: "dev" },
    });
    expect(await clerk.isConnected("default", "github")).toBe(true);
    const production = createBrainIntegrationAccounts({
      db: db as never, pipedream: {} as never, env: { NODE_ENV: "production", MATRIX_HANDLE: "dev" },
    });
    expect(await production.accounts("default", "github")).toEqual([]);
    expect(db.getUserByClerkId).toHaveBeenLastCalledWith("default");
    // Any other principal is its own Clerk id.
    expect(await accounts.accounts("dev", "github")).toEqual(["work"]);
    expect(await accounts.accounts("user_other", "github")).toEqual([]);
    expect(db.getUserByClerkId).toHaveBeenLastCalledWith("user_other");
  });

  it("has no accounts without a transport or for an owner id outside the delegation rule", async () => {
    const none = createBrainIntegrationAccounts({ db: platformDb([]) as never });
    expect(await none.isConnected("user_2abc", "github")).toBe(false);
    expect(await none.accounts("user_2abc", "github")).toEqual([]);
    const fake = fakeFetch([]);
    const remote = createBrainIntegrationAccounts({ internalBaseUrl: BASE, machineToken: MACHINE, fetch: fake.fetch });
    expect(await remote.accounts("../owner", "github")).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("rejects an outage, a refused or malformed answer and a hung platform instead of reading not connected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = fakeFetch([
      jsonResponse({ error: "no" }, 401), jsonResponse({ unexpected: true }), new Response("not json", { status: 200 }),
      new TypeError("network"), () => new Promise<Response>(() => undefined),
    ]);
    const accounts = createBrainIntegrationAccounts({ internalBaseUrl: BASE, machineToken: MACHINE, fetch: fake.fetch, timeoutMs: 20 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(accounts.isConnected("owner_a", "github")).rejects.toBeInstanceOf(BrainIntegrationAccountsError);
    }
    const db = platformDb([]);
    db.listConnectedServices.mockRejectedValueOnce(Object.assign(new Error("postgres down"), { code: "57P01" }));
    const local = createBrainIntegrationAccounts({ db: db as never, pipedream: {} as never });
    await expect(local.accounts("user_2abc", "github")).rejects.toBeInstanceOf(BrainIntegrationAccountsError);
    db.listConnectedServices.mockRejectedValueOnce("down");
    await expect(local.accounts("user_2abc", "github")).rejects.toBeInstanceOf(BrainIntegrationAccountsError);
    expect(warn.mock.calls.map((call) => call[1])).toEqual([
      "BrainIntegrationAccountsError", "BrainIntegrationAccountsError", "BrainIntegrationAccountsError", "TypeError",
      "Error", "Error", "UnknownError",
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("postgres down");
  });
});

describe("late-bound integrations", () => {
  it("answers unavailable and no accounts until bound, then forwards to the real transport, once", async () => {
    const late = createBrainLateBoundIntegrations();
    const request = { service: "github", action: "list_issues", params: { repo: "a/b" } } as const;
    expect(await late.caller.call("user_2abc", request, new AbortController().signal)).toEqual({ status: "unavailable" });
    expect(await late.isConnected("user_2abc", "github")).toBe(false);
    expect(await late.accounts("user_2abc", "github")).toEqual([]);
    const db = platformDb([{ service: "github", account_label: "work" }]);
    late.bind({ db: db as never, pipedream: {} as never });
    expect(await late.isConnected("user_2abc", "github")).toBe(true);
    expect(await late.accounts("user_2abc", "github")).toEqual(["work"]);
    // A registered read action reaches the local transport (no raw read on this fake client: unavailable, by name).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await late.caller.call("user_2abc", request, new AbortController().signal)).toEqual({ status: "unavailable" });
    expect(db.listConnectedServices).toHaveBeenCalledTimes(3);
    expect(() => late.bind({})).toThrow("already bound");
    warn.mockRestore();
  });
});
