import {
  createIntegrationConnectUrl,
  deleteIntegrationConnection,
  fetchAvailableIntegrations,
  fetchConnectedIntegrations,
  refreshIntegrationConnection,
  syncIntegrationConnections,
} from "@/lib/requests/integrations";

describe("integration requests", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("loads the available service catalog from the selected computer", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue([
        {
          id: "github",
          name: "GitHub",
          category: "developer",
          icon: "github",
          logoUrl: "https://pipedream.com/github.png",
          actions: {},
        },
      ]),
    } as unknown as Response);

    await expect(fetchAvailableIntegrations(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
    )).resolves.toEqual([
      expect.objectContaining({ id: "github", name: "GitHub", category: "developer" }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/integrations/available?runtime=preview-1",
      expect.objectContaining({ headers: { Authorization: "Bearer clerk-token" } }),
    );
  });

  it("loads connected integration accounts from the selected computer", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue([
        {
          id: "8c463220-041b-4e5e-a86c-075b07a3ff3a",
          service: "github",
          account_label: "Work",
          account_email: "dev@example.com",
          scopes: [],
          status: "active",
          connected_at: "2026-08-31T10:00:00.000Z",
          last_used_at: null,
        },
      ]),
    } as unknown as Response);

    await expect(fetchConnectedIntegrations(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
    )).resolves.toEqual([
      expect.objectContaining({ service: "github", accountLabel: "Work", status: "active" }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/integrations?runtime=preview-1",
      expect.objectContaining({ headers: { Authorization: "Bearer clerk-token" } }),
    );
  });

  it("refreshes a connected account token through the canonical endpoint", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        id: "8c463220-041b-4e5e-a86c-075b07a3ff3a",
        service: "github",
        status: "active",
      }),
    } as unknown as Response);

    await expect(refreshIntegrationConnection(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
      "8c463220-041b-4e5e-a86c-075b07a3ff3a",
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/integrations/8c463220-041b-4e5e-a86c-075b07a3ff3a/refresh?runtime=preview-1",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("deletes a connected account through the canonical endpoint", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as Response);

    await expect(deleteIntegrationConnection(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
      "8c463220-041b-4e5e-a86c-075b07a3ff3a",
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/integrations/8c463220-041b-4e5e-a86c-075b07a3ff3a?runtime=preview-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("creates a Pipedream connect URL with the mobile return route", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        url: "https://pipedream.com/connect/project?token=connect-token&app=github",
        service: "github",
      }),
    } as unknown as Response);

    await expect(createIntegrationConnectUrl(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
      "github",
    )).resolves.toBe("https://pipedream.com/connect/project?token=connect-token&app=github");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/integrations/connect?runtime=preview-1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ service: "github", redirectUri: "matrixos://integrations" }),
      }),
    );
  });
  it("opens the exact trusted Matrix Gmail consent launcher", async () => {
    const url = `https://app.matrix-os.com/auth/gmail?state=${'a'.repeat(43)}`;
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ url, service: "gmail" }) } as Response);
    await expect(createIntegrationConnectUrl("clerk-token", "https://app.matrix-os.com/vm/solar-vale", "gmail")).resolves.toBe(url);
  });
  it.each([
    `https://evil.example/auth/gmail?state=${'a'.repeat(43)}`,
    `https://app.matrix-os.com.evil.example/auth/gmail?state=${'a'.repeat(43)}`,
    `https://app.matrix-os.com/wrong?state=${'a'.repeat(43)}`,
    `https://app.matrix-os.com/auth/gmail?state=${'a'.repeat(43)}&redirect=https://evil.example`,
    `https://app.matrix-os.com/auth/gmail?state=${'a'.repeat(43)}&state=${'b'.repeat(43)}`,
    `https://secret@app.matrix-os.com/auth/gmail?state=${'a'.repeat(43)}`,
    `https://app.matrix-os.com:444/auth/gmail?state=${'a'.repeat(43)}`,
    `http://app.matrix-os.com/auth/gmail?state=${'a'.repeat(43)}`,
    "https://app.matrix-os.com/auth/gmail?state=bad",
  ])("rejects an untrusted Matrix consent URL %s", async url => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ url, service: "gmail" }) } as Response);
    await expect(createIntegrationConnectUrl("clerk-token", "https://app.matrix-os.com/vm/solar-vale", "gmail")).rejects.toThrow("Could not start connection");
  });

  it("syncs Pipedream accounts after the app returns", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ synced: 1, services: [] }),
    } as unknown as Response);

    await expect(syncIntegrationConnections(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/integrations/sync?runtime=preview-1",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
