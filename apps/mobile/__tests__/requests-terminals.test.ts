import {
  createTerminalSession,
  deleteTerminalSession,
  fetchTerminalSessions,
  renameTerminalSession,
} from "@/lib/requests/terminals";

describe("terminal requests", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("creates a terminal session with the desktop default working directory", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ name: "swift-falcon", created: true }),
    } as unknown as Response);

    await expect(createTerminalSession(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
      "swift-falcon",
    )).resolves.toBe("swift-falcon");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/terminal/sessions?runtime=preview-1",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer clerk-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "swift-falcon", cwd: "projects" }),
      }),
    );
  });

  it("loads every terminal session from the selected computer route", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        sessions: [
          {
            name: "main",
            status: "active",
            cwd: "projects/matrix-os",
            visualStatus: "running",
            branch: "main",
          },
          {
            name: "review-pr-42",
            status: "active",
            cwd: "projects/matrix-os",
            visualStatus: "waiting",
            subtitle: "Waiting for approval",
          },
          {
            name: "notes",
            status: "active",
            cwd: "~",
            visualStatus: "idle",
          },
        ],
      }),
    } as unknown as Response);

    await expect(fetchTerminalSessions(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
    )).resolves.toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/terminal/sessions?runtime=preview-1",
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("renames a terminal session through the canonical endpoint", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ session: { name: "renamed-session" } }),
    } as unknown as Response);

    await expect(renameTerminalSession(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
      "main",
      "renamed-session",
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/terminal/sessions/main/rename?runtime=preview-1",
      expect.objectContaining({
        method: "PUT",
        headers: {
          Authorization: "Bearer clerk-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "renamed-session" }),
      }),
    );
  });

  it("force-deletes a terminal session through the canonical endpoint", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as Response);

    await expect(deleteTerminalSession(
      "clerk-token",
      "https://app.matrix-os.com/vm/solar-vale?runtime=preview-1",
      "main",
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/solar-vale/api/terminal/sessions/main?runtime=preview-1&force=1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
