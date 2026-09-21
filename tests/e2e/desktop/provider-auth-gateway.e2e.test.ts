import {
  ProviderSettingsMutationResponseSchema,
  ProviderSettingsSnapshotSchema,
} from "@matrix-os/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startProviderAuthGateway } from "./fixtures/provider-auth-gateway";

let gateway: Awaited<ReturnType<typeof startProviderAuthGateway>> | undefined;

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

describe("provider authentication gateway fixture", () => {
  it("serves strict settings snapshots and opens Terminal only for login", async () => {
    gateway = await startProviderAuthGateway();

    const headers = { authorization: "Bearer stub-token-1" };
    const load = async () => ProviderSettingsSnapshotSchema.parse(await fetch(
      `${gateway!.url}/api/ai/provider-settings?includeCapabilities=true`, { headers },
    ).then((response) => response.json()));
    const unauthenticated = await load();
    expect(unauthenticated.accounts[0]?.authState).toBe("unauthenticated");
    expect(unauthenticated.accessSources[0]?.readiness.action).toBe("open_terminal");
    expect(unauthenticated.supportedActions).toEqual(["start_login"]);

    const connect = ProviderSettingsMutationResponseSchema.parse(await fetch(
      `${gateway.url}/api/ai/provider-settings/actions?includeCapabilities=true`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          type: "start_login",
          expectedRevision: unauthenticated.revision,
          idempotencyKey: "fixture_connect",
          harnessInstanceId: "claude_harness",
          accountId: "claude_account",
          method: "terminal",
        }),
      },
    ).then((response) => response.json()));
    expect(connect.kind).toBe("login_attempt");
    expect(gateway.commands[0]).toMatchObject({
      name: "Connect Claude",
      command: ["sh", "-lc", "claude auth login"],
    });

    gateway.setAuthenticated(true);
    const authenticated = await load();
    expect(authenticated.accounts[0]?.authState).toBe("authenticated");
    expect(authenticated.accessSources[0]?.readiness.action).toBe("none");
    expect(authenticated.supportedActions).toEqual(["logout_account"]);

    const disconnect = ProviderSettingsMutationResponseSchema.parse(await fetch(
      `${gateway.url}/api/ai/provider-settings/actions?includeCapabilities=true`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          type: "logout_account",
          expectedRevision: authenticated.revision,
          idempotencyKey: "fixture_disconnect",
          accountId: "claude_account",
        }),
      },
    ).then((response) => response.json()));
    expect(disconnect.kind).toBe("snapshot");
    expect(disconnect.snapshot.accounts[0]?.authState).toBe("unauthenticated");
    expect(disconnect.snapshot.supportedActions).toEqual(["start_login"]);
    expect(gateway.commands).toHaveLength(1);
  });
});
