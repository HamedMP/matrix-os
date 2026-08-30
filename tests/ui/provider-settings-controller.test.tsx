// @vitest-environment jsdom
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderSettingsMutation,
  ProviderSettingsMutationResponse,
  ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import {
  ProviderSettingsController,
  ProviderSettingsTransportError,
  useProviderSettingsController,
  type ProviderSettingsTransport,
} from "../../packages/ui/src/agents-providers/provider-settings-controller";

const checkedAt = "2026-08-30T10:00:00.000Z";

function snapshot(revision: number, harnessIds = ["harness_one"]): ProviderSettingsSnapshot {
  return {
    contractVersion: 1,
    projectionOf: { contract: "AiProviderSnapshotV3", contractVersion: 3, revision },
    revision,
    refreshedAt: checkedAt,
    access: { mode: "writable" },
    supportedActions: ["update_harness", "set_harness_enabled", "start_login"],
    modelProviders: [{
      id: "anthropic",
      displayName: "Anthropic",
      models: [{ id: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5", enabled: true }],
    }],
    accessSources: [{
      id: "source_matrix",
      kind: "matrix_gateway",
      fundingKind: "matrix_included",
      providerId: "anthropic",
      accountId: null,
      displayName: "Matrix AI",
      readiness: { state: "ready", checkedAt, staleAfter: null, action: "none", safeReason: null },
      eligibleModelIds: ["anthropic/claude-sonnet-5"],
      usage: {
        kind: "unavailable",
        authority: "unavailable",
        state: "unavailable",
        scope: "owner_entitlement",
        reason: "ledger_not_available",
        asOf: checkedAt,
      },
    }],
    accounts: [],
    harnesses: harnessIds.map((id, index) => ({
      id,
      harness: "hermes" as const,
      displayName: `Hermes ${index + 1}`,
      accentColor: "teal" as const,
      enabled: true,
      version: "1.0.0",
      installState: "installed" as const,
      authState: "authenticated" as const,
      loginMethods: ["terminal" as const],
      recommendedLoginMethod: "terminal" as const,
      connectivity: "online" as const,
      accountIds: [],
      selectedAccountId: null,
      accessSourceId: "source_matrix",
      route: {
        kind: "configurable" as const,
        providerId: "anthropic",
        modelId: "anthropic/claude-sonnet-5",
      },
      activeChatCount: 0,
    })),
    gatewayPolicy: {
      accessSourceId: "source_matrix",
      monthlyBudgetMicrousd: null,
      allowedModelIds: ["anthropic/claude-sonnet-5"],
      topUpEnabled: false,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function transport(options: {
  getSnapshot?: ProviderSettingsTransport["getSnapshot"];
  mutate?: ProviderSettingsTransport["mutate"];
} = {}) {
  return {
    getSnapshot: vi.fn(options.getSnapshot ?? (async () => snapshot(1))),
    mutate: vi.fn(options.mutate ?? (async () => ({ kind: "snapshot", snapshot: snapshot(2) }))),
  } satisfies ProviderSettingsTransport;
}

afterEach(() => vi.restoreAllMocks());

describe("ProviderSettingsController", () => {
  it("parses the initial snapshot and selects its first harness", async () => {
    const gateway = transport();
    const controller = new ProviderSettingsController({ identityKey: "owner-a:primary", transport: gateway });

    await controller.refresh();

    expect(controller.getState().snapshot?.revision).toBe(1);
    expect(controller.getState().selectedHarnessId).toBe("harness_one");
    expect(controller.getState().error).toBeNull();
  });

  it("adds the current revision and a crypto UUID, then exposes a parsed login attempt", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
    const response: ProviderSettingsMutationResponse = {
      kind: "login_attempt",
      snapshot: {
        ...snapshot(2),
        harnesses: snapshot(2).harnesses.map((harness) => ({ ...harness, authState: "authenticating" })),
      },
      attempt: {
        id: "attempt_one",
        harnessInstanceId: "harness_one",
        accountId: null,
        method: "terminal",
        state: "pending",
        action: { kind: "open_terminal", terminalSessionId: "matrix-login" },
        expiresAt: "2026-08-30T10:10:00.000Z",
        safeFailure: null,
      },
    };
    const gateway = transport({ mutate: async () => response });
    const controller = new ProviderSettingsController({ identityKey: "owner-a:primary", transport: gateway });
    await controller.refresh();

    await controller.mutate({
      type: "start_login",
      harnessInstanceId: "harness_one",
      accountId: null,
      method: "terminal",
    });

    expect(gateway.mutate).toHaveBeenCalledWith({
      type: "start_login",
      harnessInstanceId: "harness_one",
      accountId: null,
      method: "terminal",
      expectedRevision: 1,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
    }, expect.any(AbortSignal));
    expect(controller.getState().snapshot?.revision).toBe(2);
    expect(controller.getState().connectionAttempt?.id).toBe("attempt_one");
  });

  it("serializes mutations and reads the latest confirmed revision when each starts", async () => {
    const first = deferred<ProviderSettingsMutationResponse>();
    const requests: ProviderSettingsMutation[] = [];
    const gateway = transport({
      mutate: async (mutation) => {
        requests.push(mutation);
        if (requests.length === 1) return first.promise;
        return { kind: "snapshot", snapshot: snapshot(3) };
      },
    });
    const controller = new ProviderSettingsController({ identityKey: "owner-a:primary", transport: gateway });
    await controller.refresh();

    const one = controller.mutate({ type: "update_harness", harnessInstanceId: "harness_one", displayName: "One" });
    const two = controller.mutate({ type: "set_harness_enabled", harnessInstanceId: "harness_one", enabled: false });
    await Promise.resolve();
    expect(gateway.mutate).toHaveBeenCalledTimes(1);

    first.resolve({ kind: "snapshot", snapshot: snapshot(2) });
    await Promise.all([one, two]);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.expectedRevision).toBe(1);
    expect(requests[1]?.expectedRevision).toBe(2);
    expect(controller.getState().snapshot?.revision).toBe(3);
    expect(controller.getState().busy).toBe(false);
  });

  it("keeps the last server-confirmed snapshot while a mutation is pending", async () => {
    const response = deferred<ProviderSettingsMutationResponse>();
    const gateway = transport({ mutate: async () => response.promise });
    const controller = new ProviderSettingsController({ identityKey: "owner-a:primary", transport: gateway });
    await controller.refresh();

    const mutation = controller.mutate({
      type: "update_harness",
      harnessInstanceId: "harness_one",
      displayName: "Confirmed later",
    });
    await Promise.resolve();

    expect(controller.getState().snapshot?.revision).toBe(1);
    response.resolve({ kind: "snapshot", snapshot: snapshot(2) });
    await mutation;
    expect(controller.getState().snapshot?.revision).toBe(2);
  });

  it("fails closed when the server does not advertise an action", async () => {
    const gateway = transport();
    const controller = new ProviderSettingsController({ identityKey: "owner-a:primary", transport: gateway });
    await controller.refresh();

    await controller.mutate({ type: "set_gateway_budget", monthlyBudgetMicrousd: 1_000_000 });

    expect(gateway.mutate).not.toHaveBeenCalled();
    expect(controller.getState().snapshot?.revision).toBe(1);
    expect(controller.getState().error).toBe("Changes were not saved. Refresh and try again.");
  });

  it("does not let an older refresh overwrite a later mutation response", async () => {
    const staleRefresh = deferred<unknown>();
    let loads = 0;
    const gateway = transport({
      getSnapshot: async () => {
        loads += 1;
        return loads === 1 ? snapshot(1) : staleRefresh.promise;
      },
      mutate: async () => ({ kind: "snapshot", snapshot: snapshot(2) }),
    });
    const controller = new ProviderSettingsController({ identityKey: "owner-a:primary", transport: gateway });
    await controller.refresh();

    const refresh = controller.refresh();
    await controller.mutate({ type: "update_harness", harnessInstanceId: "harness_one", displayName: "Latest" });
    staleRefresh.resolve(snapshot(1));
    await refresh;

    expect(controller.getState().snapshot?.revision).toBe(2);
  });

  it("reloads authoritative state after a revision conflict and never exposes raw errors", async () => {
    let loads = 0;
    const gateway = transport({
      getSnapshot: async () => snapshot(++loads),
      mutate: async () => {
        throw new ProviderSettingsTransportError("revision_conflict", "Anthropic sk-secret /private/path");
      },
    });
    const controller = new ProviderSettingsController({ identityKey: "owner-a:primary", transport: gateway });
    await controller.refresh();

    await controller.mutate({ type: "update_harness", harnessInstanceId: "harness_one", displayName: "Conflict" });

    expect(gateway.getSnapshot).toHaveBeenCalledTimes(2);
    expect(controller.getState().snapshot?.revision).toBe(2);
    expect(controller.getState().error).toBe("Provider settings changed. Latest settings were loaded.");
    expect(controller.getState().error).not.toContain("Anthropic");
  });

  it("keeps a selected harness while it exists and falls back after removal", async () => {
    let next = snapshot(1, ["harness_one", "harness_two"]);
    const gateway = transport({ getSnapshot: async () => next });
    const controller = new ProviderSettingsController({ identityKey: "owner-a:primary", transport: gateway });
    await controller.refresh();
    controller.selectHarness("harness_two");

    next = snapshot(2, ["harness_one", "harness_two"]);
    await controller.refresh();
    expect(controller.getState().selectedHarnessId).toBe("harness_two");

    next = snapshot(3, ["harness_one"]);
    await controller.refresh();
    expect(controller.getState().selectedHarnessId).toBe("harness_one");
  });

  it("fails closed on malformed responses with an allowlisted generic message", async () => {
    const gateway = transport({ getSnapshot: async () => ({ secret: "sk-private" }) });
    const controller = new ProviderSettingsController({ identityKey: "owner-a:primary", transport: gateway });

    await controller.refresh();

    expect(controller.getState().snapshot).toBeNull();
    expect(controller.getState().error).toBe("Provider settings are unavailable.");
  });

  it("caps tracked requests by aborting the oldest refresh", async () => {
    const signals: AbortSignal[] = [];
    const gateway = transport({
      getSnapshot: async (signal) => {
        signals.push(signal);
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      },
    });
    const controller = new ProviderSettingsController({ identityKey: "owner-a:primary", transport: gateway });

    const refreshes = Array.from({ length: 5 }, () => controller.refresh());
    await waitFor(() => expect(signals).toHaveLength(5));
    expect(signals[0]?.aborted).toBe(true);
    controller.dispose();
    await Promise.all(refreshes);
  });

  it("caps subscriptions rather than growing the listener registry indefinitely", () => {
    const controller = new ProviderSettingsController({ identityKey: "owner-a:primary", transport: transport() });
    const unsubscribers = Array.from({ length: 64 }, () => controller.subscribe(() => undefined));

    expect(() => controller.subscribe(() => undefined)).toThrow("subscription limit");
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });

  it("clears a retained login attempt after it expires or authentication succeeds", async () => {
    let next = snapshot(1);
    const gateway = transport({
      getSnapshot: async () => next,
      mutate: async () => {
        const responseSnapshot = snapshot(next.revision + 1);
        return {
          kind: "login_attempt",
          snapshot: {
            ...responseSnapshot,
            harnesses: responseSnapshot.harnesses.map((harness) => ({ ...harness, authState: "authenticating" })),
          },
          attempt: {
            id: "attempt_one",
            harnessInstanceId: "harness_one",
            accountId: null,
            method: "terminal",
            state: "pending",
            action: { kind: "open_terminal", terminalSessionId: "matrix-login" },
            expiresAt: "2026-08-30T10:10:00.000Z",
            safeFailure: null,
          },
        };
      },
    });
    const controller = new ProviderSettingsController({ identityKey: "owner-a:primary", transport: gateway });
    await controller.refresh();
    await controller.mutate({ type: "start_login", harnessInstanceId: "harness_one", accountId: null, method: "terminal" });
    expect(controller.getState().connectionAttempt?.id).toBe("attempt_one");

    next = {
      ...snapshot(3),
      refreshedAt: "2026-08-30T10:11:00.000Z",
      harnesses: snapshot(3).harnesses.map((harness) => ({ ...harness, authState: "unauthenticated" })),
    };
    await controller.refresh();
    expect(controller.getState().connectionAttempt).toBeNull();

    await controller.mutate({ type: "start_login", harnessInstanceId: "harness_one", accountId: null, method: "terminal" });
    expect(controller.getState().connectionAttempt?.id).toBe("attempt_one");
    next = snapshot(4);
    await controller.refresh();
    expect(controller.getState().connectionAttempt).toBeNull();
  });
});

describe("useProviderSettingsController", () => {
  it("loads through React strict-mode effect replay", async () => {
    const gateway = transport();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <React.StrictMode>{children}</React.StrictMode>
    );
    const { result } = renderHook(
      () => useProviderSettingsController({ identityKey: "owner-a:primary", transport: gateway }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.snapshot?.revision).toBe(1));
  });

  it("clears prior-owner state immediately and ignores its late response", async () => {
    const ownerALoad = deferred<unknown>();
    const ownerA = transport({ getSnapshot: async () => ownerALoad.promise });
    const ownerB = transport({ getSnapshot: async () => snapshot(20, ["harness_two"]) });
    const { result, rerender } = renderHook(
      ({ identityKey, currentTransport }) => useProviderSettingsController({
        identityKey,
        transport: currentTransport,
      }),
      { initialProps: { identityKey: "owner-a:primary", currentTransport: ownerA as ProviderSettingsTransport } },
    );

    expect(result.current.snapshot).toBeNull();
    rerender({ identityKey: "owner-b:primary", currentTransport: ownerB });
    expect(result.current.snapshot).toBeNull();

    await waitFor(() => expect(result.current.snapshot?.revision).toBe(20));
    await act(async () => ownerALoad.resolve(snapshot(10)));
    expect(result.current.snapshot?.revision).toBe(20);
    expect(result.current.identityKey).toBe("owner-b:primary");
  });
});
