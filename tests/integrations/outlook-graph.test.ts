import { describe, expect, it, vi } from "vitest";
import { createOutlookGraph } from "../../packages/gateway/src/integrations/outlook/graph.js";

const userId = "owner";
const connectionId = "connection";
const service = "microsoft_outlook";
const calendarService = "microsoft_outlook_calendar";

describe("Direct Outlook Graph actions", () => {
  const connect = (...responses: Response[]) => {
    const accessToken = vi.fn(async () => "microsoft-access");
    const fetcher = vi.fn<typeof fetch>();
    for (const response of responses) fetcher.mockResolvedValueOnce(response);
    const execute = createOutlookGraph({ lifecycle: { accessToken }, fetcher });
    return { execute, fetcher, accessToken };
  };

  it("runs existing mail and calendar reads with the selected native grant", async () => {
    const { execute, fetcher, accessToken } = connect(Response.json({ value: [] }), Response.json({ value: [] }));
    await expect(execute({ userId, connectionId, service, action: "list_messages", params: { limit: 12 } }))
      .resolves.toEqual({ value: [] });
    await expect(execute({ userId, connectionId, service: calendarService, action: "list_calendars" }))
      .resolves.toEqual({ value: [] });
    expect(accessToken).toHaveBeenNthCalledWith(1, userId, service, connectionId, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(accessToken).toHaveBeenNthCalledWith(2, userId, calendarService, connectionId, expect.any(Object));
    expect(fetcher).toHaveBeenNthCalledWith(1, "https://graph.microsoft.com/v1.0/me/messages?%24top=12", expect.objectContaining({
      method: "GET", headers: expect.objectContaining({ Authorization: "Bearer microsoft-access" }), redirect: "error",
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "https://graph.microsoft.com/v1.0/me/calendars?%24top=25", expect.any(Object));
  });

  it("builds bounded draft and event bodies and never retries an ambiguous write", async () => {
    const { execute, fetcher } = connect(Response.json({ id: "draft" }, { status: 201 }), Response.json({}, { status: 503 }));
    await expect(execute({ userId, connectionId, service, action: "create_draft", params: { subject: "Review", body: "Notes" } }))
      .resolves.toEqual({ id: "draft" });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ subject: "Review", body: { contentType: "Text", content: "Notes" } });
    await expect(execute({ userId, connectionId, service: calendarService, action: "create_event", params: {
      calendarId: "calendar+=", subject: "Focus", startDateTime: "2026-11-27T10:00:00Z", endDateTime: "2026-11-27T11:00:00Z",
    } })).rejects.toMatchObject({ code: "unavailable" });
    expect(fetcher.mock.calls[1][0]).toBe("https://graph.microsoft.com/v1.0/me/calendars/calendar%2B%3D/events");
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      subject: "Focus", start: { dateTime: "2026-11-27T10:00:00", timeZone: "UTC" }, end: { dateTime: "2026-11-27T11:00:00", timeZone: "UTC" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported actions and parameters before resolving any tokens", async () => {
    const { execute, fetcher, accessToken } = connect();
    await expect(execute({ userId, connectionId, service, action: "send_mail" })).rejects.toMatchObject({ code: "unavailable" });
    await expect(execute({ userId, connectionId, service, action: "create_draft", params: { subject: "x", body: "x", toRecipients: [] } }))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(accessToken).not.toHaveBeenCalled();
  });

  it("renews once on an expired read and surfaces throttling", async () => {
    const { execute, accessToken, fetcher } = connect(new Response(null, { status: 401 }),
      new Response(null, { status: 429, headers: { "Retry-After": "20" } }));
    await expect(execute({ userId, connectionId, service, action: "list_folders" }))
      .rejects.toMatchObject({ code: "throttled", retryAfter: 20 });
    expect(accessToken).toHaveBeenLastCalledWith(userId, service, connectionId, expect.objectContaining({ forceRefresh: true }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
