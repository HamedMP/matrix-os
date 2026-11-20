import { DEFAULT_NOTIFICATION_PREFERENCES, NotificationPreferencesSchema } from "@matrix-os/contracts/notifications";
import { GatewayClient } from "../lib/gateway-client";
import { jsonResponse } from "./mobile-shell-test-utils";

describe("owner notification preferences transport", () => {
  afterEach(() => jest.restoreAllMocks());
  it("round-trips the shared full document with refreshed auth and runtime routing", async () => {
    const preferences = NotificationPreferencesSchema.parse({ ...DEFAULT_NOTIFICATION_PREFERENCES, revision: 7 });
    const committed = { ...preferences, revision: 8 };
    const fetchMock = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({ preferences }))
      .mockResolvedValueOnce(jsonResponse({ preferences: committed }));
    const token = jest.fn().mockResolvedValue("fresh-token");
    const client = new GatewayClient("https://app.matrix-os.com/vm/test?runtime=preview", token);
    expect(await client.getNotificationPreferences()).toEqual({ ok: true, preferences });
    expect(await client.updateNotificationPreferences(preferences)).toEqual({ ok: true, preferences: committed });
    const [url, request] = fetchMock.mock.calls[1]!;
    expect(url).toBe("https://app.matrix-os.com/vm/test/api/notifications/preferences?runtime=preview");
    expect(request).toMatchObject({ method: "PUT", headers: { Authorization: "Bearer fresh-token" } });
    expect(NotificationPreferencesSchema.parse(JSON.parse(request!.body as string))).toEqual(preferences);
    expect(request!.signal).toBeDefined();
    expect(token).toHaveBeenCalledTimes(2);
  });
  it.each([409, 404, 503])("distinguishes refusal %s without exposing the body", async (status) => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ error: "/home/private/provider-secret" }, { status }));
    const client = new GatewayClient("http://localhost:4000", "token");
    expect(await client.updateNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES)).toEqual({
      ok: false, reason: status === 409 ? "conflict" : status === 404 ? "unsupported" : "unavailable",
    });
  });
  it("rejects malformed server data and invalid writes", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, revision: -1 } }));
    const client = new GatewayClient("http://localhost:4000", "token");
    expect(await client.getNotificationPreferences()).toEqual({ ok: false, reason: "unavailable" });
    fetchMock.mockClear();
    expect(await client.updateNotificationPreferences({ ...DEFAULT_NOTIFICATION_PREFERENCES, revision: -1 })).toEqual({ ok: false, reason: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not report success when the server returns an uncommitted revision", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ preferences: DEFAULT_NOTIFICATION_PREFERENCES }));
    const client = new GatewayClient("http://localhost:4000", "token");
    expect(await client.updateNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES)).toEqual({ ok: false, reason: "unavailable" });
  });
});
