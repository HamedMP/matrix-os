import {
  createAppSession,
  fetchInstalledApps,
} from "@/lib/requests/apps";

describe("app requests", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("loads installed apps from the selected computer", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue([
        {
          name: "Notes",
          description: "Rich markdown notes",
          category: "productivity",
          icon: "notes",
          slug: "notes",
          runtime: "vite",
          file: "notes/index.html",
          path: "/files/apps/notes/index.html",
          launchUrl: "/apps/notes/",
        },
      ]),
    } as unknown as Response);

    await expect(fetchInstalledApps(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
    )).resolves.toEqual([
      expect.objectContaining({ name: "Notes", slug: "notes", icon: "notes" }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/apps?runtime=preview-1",
      expect.objectContaining({ headers: { Authorization: "Bearer clerk-token" } }),
    );
  });

  it("creates a short-lived authenticated app session", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        launchUrl: "/apps/notes/?session=session-token",
        expiresAt: 1_800_000_000_000,
      }),
    } as unknown as Response);

    await expect(createAppSession(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
      "notes",
    )).resolves.toEqual({
      launchUrl: "/apps/notes/?session=session-token",
      expiresAt: 1_800_000_000_000,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/apps/notes/session-token?runtime=preview-1",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });
});
