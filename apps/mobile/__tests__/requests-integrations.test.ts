import {
  createIntegrationConnectUrl,
  deleteIntegrationConnection,
  fetchAvailableIntegrations,
  fetchGmailConnectionOptions,
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

describe("Gmail pilot connection methods", () => {
  beforeEach(() => jest.restoreAllMocks());
  afterEach(() => jest.restoreAllMocks());
  it.each(["matrix", "pipedream"] as const)("preserves explicit %s choice, label and native return URI", async connectionMethod => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ url: "https://pipedream.com/connect/test", service: "gmail" }) } as Response);
    await createIntegrationConnectUrl("token", "https://app.matrix-os.com/vm/test?runtime=preview-1", "gmail", { connectionMethod, label: "Work" });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({ service: "gmail", connectionMethod, label: "Work", redirectUri: "matrixos://integrations" });
  });
});

describe("Gmail capability discovery", () => {
  beforeEach(() => jest.restoreAllMocks());
  afterEach(() => jest.restoreAllMocks());
  it("authenticates discovery on the selected runtime", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200, json: async () => ({ methods: ["matrix", "pipedream"], defaultMethod: "matrix" }) } as Response);
    await expect(fetchGmailConnectionOptions("token", "https://app.matrix-os.com/vm/test?runtime=preview-1")).resolves.toEqual({ methods: ["matrix", "pipedream"], defaultMethod: "matrix" });
    expect(fetchMock).toHaveBeenCalledWith("https://app.matrix-os.com/vm/test/api/integrations/gmail/connection-options?runtime=preview-1", expect.objectContaining({ headers: { Authorization: "Bearer token" } }));
  });
  it("treats only a missing endpoint as Pipedream-only", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce({ ok: false, status: 404 } as Response).mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    await expect(fetchGmailConnectionOptions("token", "https://app.matrix-os.com")).resolves.toEqual({ methods: ["pipedream"], defaultMethod: "pipedream" });
    await expect(fetchGmailConnectionOptions("token", "https://app.matrix-os.com")).rejects.toThrow("Could not load Gmail connection options. Try again.");
  });
});
