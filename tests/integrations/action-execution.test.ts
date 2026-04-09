import { describe, it, expect, vi } from "vitest";
import {
  executeIntegrationAction,
  IntegrationActionNotImplementedError,
} from "../../packages/gateway/src/integrations/routes.js";
import { getAction, getService } from "../../packages/gateway/src/integrations/registry.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

function mockPipedream(): PipedreamConnectClient {
  return {
    createConnectToken: vi.fn(),
    getOAuthUrl: vi.fn(),
    callAction: vi.fn(),
    discoverActions: vi.fn(),
    runAction: vi.fn(),
    proxyGet: vi.fn(),
    proxyPost: vi.fn(),
    proxyPut: vi.fn(),
    proxyPatch: vi.fn(),
    proxyDelete: vi.fn(),
    revokeAccount: vi.fn(),
    listAccounts: vi.fn(),
    getAppInfo: vi.fn(),
  } as unknown as PipedreamConnectClient;
}

describe("executeIntegrationAction", () => {
  it("dispatches PATCH directApi actions with proxyPatch", async () => {
    const pipedream = mockPipedream();
    vi.mocked(pipedream.proxyPatch).mockResolvedValue({ ok: true });

    const service = getService("google_calendar")!;
    const action = getAction("google_calendar", "update_event")!;

    await executeIntegrationAction({
      pipedream,
      externalUserId: "user-1",
      connection: { pipedream_account_id: "acc-1" },
      def: service,
      actionDef: action,
      serviceId: "google_calendar",
      actionId: "update_event",
      params: {
        eventId: "evt_123",
        summary: "Renamed",
      },
    });

    expect(pipedream.proxyPatch).toHaveBeenCalledWith({
      externalUserId: "user-1",
      accountId: "acc-1",
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_123",
      body: { summary: "Renamed" },
    });
    expect(pipedream.proxyPost).not.toHaveBeenCalled();
  });

  it("dispatches DELETE directApi actions with proxyDelete", async () => {
    const pipedream = mockPipedream();
    vi.mocked(pipedream.proxyDelete).mockResolvedValue(undefined);

    const service = getService("google_calendar")!;
    const action = getAction("google_calendar", "delete_event")!;

    await executeIntegrationAction({
      pipedream,
      externalUserId: "user-1",
      connection: { pipedream_account_id: "acc-1" },
      def: service,
      actionDef: action,
      serviceId: "google_calendar",
      actionId: "delete_event",
      params: {
        eventId: "evt_456",
      },
    });

    expect(pipedream.proxyDelete).toHaveBeenCalledWith({
      externalUserId: "user-1",
      accountId: "acc-1",
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_456",
      params: undefined,
    });
    expect(pipedream.proxyPost).not.toHaveBeenCalled();
  });

  it("throws a not-implemented error instead of calling a fabricated fallback URL", async () => {
    const pipedream = mockPipedream();
    const service = getService("google_drive")!;
    const action = getAction("google_drive", "upload_file")!;

    await expect(
      executeIntegrationAction({
        pipedream,
        externalUserId: "user-1",
        connection: { pipedream_account_id: "acc-1" },
        def: service,
        actionDef: action,
        serviceId: "google_drive",
        actionId: "upload_file",
        params: { name: "notes.txt", content: "hello" },
      }),
    ).rejects.toBeInstanceOf(IntegrationActionNotImplementedError);

    expect(pipedream.callAction).not.toHaveBeenCalled();
  });
});
