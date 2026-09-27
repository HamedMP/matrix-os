import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActiveOrganizationTracker,
  fetchActiveOrganizationId,
} from "@desktop/main/auth/active-organization";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function organizations(...ids: string[]) {
  return {
    organizations: ids.map((organizationId) => ({
      organizationId,
      name: `Team ${organizationId}`,
      slug: organizationId.replace("org_", ""),
      role: "member",
      aiSubmission: "members",
      membershipEpoch: 1,
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchActiveOrganizationId", () => {
  it("reads the platform membership listing with the trusted credential and a bounded request", async () => {
    const fetchFn = vi.fn(async (_input: string, _init?: RequestInit) => jsonResponse(organizations("org_matrix_team")));

    await expect(fetchActiveOrganizationId({
      fetchFn,
      origin: "https://api.matrix-os.com",
      accessToken: "opaque-device-token",
    })).resolves.toBe("org_matrix_team");

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.matrix-os.com/api/organizations");
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { authorization: "Bearer opaque-device-token", accept: "application/json" },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns no organization when the account has none or several (no switch yet)", async () => {
    for (const body of [organizations(), organizations("org_alpha", "org_beta")]) {
      await expect(fetchActiveOrganizationId({
        fetchFn: async () => jsonResponse(body),
        origin: "https://api.matrix-os.com",
        accessToken: "tok",
      })).resolves.toBeNull();
    }
  });

  it("treats a repeated membership row for one organization as that organization", async () => {
    await expect(fetchActiveOrganizationId({
      fetchFn: async () => jsonResponse(organizations("org_alpha", "org_alpha")),
      origin: "https://api.matrix-os.com",
      accessToken: "tok",
    })).resolves.toBe("org_alpha");
  });

  it("answers no organization when the platform cannot list memberships for this credential", async () => {
    for (const status of [401, 403, 404]) {
      await expect(fetchActiveOrganizationId({
        fetchFn: async () => jsonResponse({ error: "Unauthorized" }, status),
        origin: "https://api.matrix-os.com",
        accessToken: "tok",
      })).resolves.toBeNull();
    }
  });

  it("rejects transient failures, malformed identifiers and oversized bodies", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => jsonResponse({ error: "Organizations unavailable" }, 503),
      async () => jsonResponse({ organizations: [{ organizationId: "not-an-org" }] }),
      async () => jsonResponse({ organizations: "org_alpha" }),
      async () => new Response("not json", { status: 200 }),
      async () => new Response(JSON.stringify(organizations("org_alpha")), {
        status: 200,
        headers: { "content-length": String(1024 * 1024) },
      }),
      async () => jsonResponse({ organizations: [], padding: "x".repeat(128 * 1024) }),
    ];
    for (const fetchFn of cases) {
      await expect(fetchActiveOrganizationId({
        fetchFn,
        origin: "https://api.matrix-os.com",
        accessToken: "tok",
      })).rejects.toThrow();
    }
  });
});

describe("ActiveOrganizationTracker", () => {
  function makeTracker(fetchFn: (input: string, init?: RequestInit) => Promise<Response>, now = () => 1_000) {
    const onChanged = vi.fn();
    const tracker = new ActiveOrganizationTracker({
      origin: "https://api.matrix-os.com",
      fetchFn,
      now,
      onChanged,
    });
    return { tracker, onChanged };
  }

  it("publishes the resolved organization only for the account it was resolved for", async () => {
    const { tracker, onChanged } = makeTracker(async () => jsonResponse(organizations("org_matrix_team")));

    await tracker.refresh({ userId: "user-1", accessToken: "tok", isCurrent: () => true });

    expect(tracker.organizationFor("user-1")).toBe("org_matrix_team");
    expect(tracker.organizationFor("user-2")).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);

    await tracker.refresh({ userId: "user-1", accessToken: "tok", isCurrent: () => true });
    expect(onChanged).toHaveBeenCalledTimes(1);

    tracker.clear();
    expect(tracker.organizationFor("user-1")).toBeNull();
  });

  it("drops a result whose credential was replaced while the request was in flight", async () => {
    const pending = deferred<Response>();
    const { tracker, onChanged } = makeTracker(() => pending.promise);
    let current = true;

    const refresh = tracker.refresh({ userId: "user-1", accessToken: "tok", isCurrent: () => current });
    current = false;
    pending.resolve(jsonResponse(organizations("org_matrix_team")));
    await refresh;

    expect(tracker.organizationFor("user-1")).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("shares one request between concurrent refreshes and throttles fresh results", async () => {
    let clock = 1_000;
    const fetchFn = vi.fn(async () => jsonResponse(organizations("org_matrix_team")));
    const { tracker } = makeTracker(fetchFn, () => clock);

    await Promise.all([
      tracker.refresh({ userId: "user-1", accessToken: "tok", isCurrent: () => true }),
      tracker.refresh({ userId: "user-1", accessToken: "tok", isCurrent: () => true }),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    clock += 30_000;
    await tracker.refresh({ userId: "user-1", accessToken: "tok", isCurrent: () => true, maxAgeMs: 60_000 });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    clock += 31_000;
    await tracker.refresh({ userId: "user-1", accessToken: "tok", isCurrent: () => true, maxAgeMs: 60_000 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("keeps the last known organization and logs a generic reason when a refresh fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse(organizations("org_matrix_team")))
      .mockRejectedValueOnce(new TypeError("fetch failed: getaddrinfo ENOTFOUND api.matrix-os.com"));
    const { tracker, onChanged } = makeTracker(fetchFn);

    await tracker.refresh({ userId: "user-1", accessToken: "tok", isCurrent: () => true });
    await expect(tracker.refresh({ userId: "user-1", accessToken: "tok", isCurrent: () => true })).resolves.toBeUndefined();

    expect(tracker.organizationFor("user-1")).toBe("org_matrix_team");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[auth] active organization unavailable:", "TypeError");
  });

  it("notifies when a later listing removes the organization", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse(organizations("org_matrix_team")))
      .mockResolvedValueOnce(jsonResponse(organizations()));
    const { tracker, onChanged } = makeTracker(fetchFn);

    await tracker.refresh({ userId: "user-1", accessToken: "tok", isCurrent: () => true });
    await tracker.refresh({ userId: "user-1", accessToken: "tok", isCurrent: () => true });

    expect(tracker.organizationFor("user-1")).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});
