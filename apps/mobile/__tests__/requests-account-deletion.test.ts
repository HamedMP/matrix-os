jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.matrix-os.com",
}));

import {
  AccountDeletionRequestError,
  cancelAccountDeletion,
  fetchAccountDeletionStatus,
  fetchAccountExportFiles,
  fetchAccountRecords,
  scheduleAccountDeletion,
} from "@/lib/requests/account-deletion";

const scheduled = {
  status: "scheduled",
  erasesAfter: "2026-10-11T15:13:43.000Z",
  completesBy: "2026-10-12T15:13:43.000Z",
  billingStopped: true,
};

function respond(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

async function failureOf(request: Promise<unknown>): Promise<AccountDeletionRequestError> {
  try {
    await request;
  } catch (error: unknown) {
    if (error instanceof AccountDeletionRequestError) return error;
    throw error;
  }
  throw new Error("Expected the request to fail");
}

describe("account deletion requests", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("reads the current state with the Clerk session token and a timeout", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond(scheduled));

    await expect(fetchAccountDeletionStatus("clerk-token")).resolves.toEqual(scheduled);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.matrix-os.com/api/account/delete",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer clerk-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("accepts the state of an account with no deletion request", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      respond({ status: "none", erasesAfter: null, completesBy: null, billingStopped: false }),
    );

    await expect(fetchAccountDeletionStatus("clerk-token")).resolves.toMatchObject({
      status: "none",
      erasesAfter: null,
    });
  });

  it("keeps the manual Apple revocation flag", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      respond({ ...scheduled, manualAppleRevocationRequired: true }),
    );

    await expect(fetchAccountDeletionStatus("clerk-token")).resolves.toMatchObject({
      manualAppleRevocationRequired: true,
    });
  });

  it.each([
    ["schedules deletion", scheduleAccountDeletion, "/api/account/delete", 202],
    ["cancels deletion", cancelAccountDeletion, "/api/account/delete/cancel", 200],
  ] as const)("%s with the strict confirmation body", async (_name, request, path, status) => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond(scheduled, status));

    await expect(request("clerk-token")).resolves.toEqual(scheduled);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://app.matrix-os.com${path}`,
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer clerk-token", "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("reports an ownership conflict from its code, not from the server's wording", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      respond({ error: "Server wording that must not reach the screen", code: "ownership_transfer_required" }, 409),
    );

    const failure = await failureOf(scheduleAccountDeletion("clerk-token"));

    expect(failure.reason).toBe("ownership_transfer_required");
    expect(failure.message).not.toContain("Server wording");
  });

  it("reports any other conflict as a closed stage", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      respond({ error: "Cancellation is not available at this stage." }, 409),
    );

    expect((await failureOf(cancelAccountDeletion("clerk-token"))).reason).toBe("conflict");
  });

  it("still reports a conflict when the conflict body is not JSON", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 409,
      json: jest.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
    } as unknown as Response);

    expect((await failureOf(cancelAccountDeletion("clerk-token"))).reason).toBe("conflict");
  });

  it.each([401, 404, 422, 503])("reports HTTP %s as unavailable", async (status) => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      respond({ error: "postgres://internal detail" }, status),
    );

    const failure = await failureOf(fetchAccountDeletionStatus("clerk-token"));

    expect(failure.reason).toBe("unavailable");
    expect(failure.message).not.toContain("postgres");
  });

  it("reports a network failure as unavailable", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new TypeError("Network request failed"));

    expect((await failureOf(scheduleAccountDeletion("clerk-token"))).reason).toBe("unavailable");
  });

  it("reports an unrecognised state as unavailable instead of trusting it", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(respond({ status: "paused", billingStopped: true }));

    expect((await failureOf(fetchAccountDeletionStatus("clerk-token"))).reason).toBe("unavailable");
  });

  it("does not call the server without a session token", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond(scheduled));

    expect((await failureOf(scheduleAccountDeletion("  "))).reason).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("backed-up files", () => {
    const page = {
      downloads: [
        { name: "home/notes.md", url: "https://storage.example/notes?sig=1" },
        { name: "db/app.dump", url: "https://storage.example/app?sig=2" },
      ],
      migrationUrl: "/runtime",
      instructions: ["Download all pages before erasure begins."],
      nextCursor: "page-2",
    };

    it("lists the first page of download links", async () => {
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond(page));

      await expect(fetchAccountExportFiles("clerk-token")).resolves.toEqual({
        files: page.downloads,
        instructions: page.instructions,
        nextCursor: "page-2",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://app.matrix-os.com/api/account/delete/export",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("passes the cursor for the next page", async () => {
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
        respond({ ...page, nextCursor: null }),
      );

      await expect(fetchAccountExportFiles("clerk-token", "page 2/=")).resolves.toMatchObject({
        nextCursor: null,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://app.matrix-os.com/api/account/delete/export?cursor=page%202%2F%3D",
        expect.anything(),
      );
    });

    it("drops links that are not HTTPS", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(
        respond({
          ...page,
          downloads: [
            { name: "safe", url: "https://storage.example/safe" },
            { name: "plain", url: "http://storage.example/plain" },
            { name: "script", url: "javascript:alert(1)" },
            { name: "relative", url: "/files/relative" },
          ],
        }),
      );

      const result = await fetchAccountExportFiles("clerk-token");

      expect(result.files).toEqual([{ name: "safe", url: "https://storage.example/safe" }]);
    });

    it("reports a closed download window as a conflict", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(
        respond({ error: "Data is no longer available for download." }, 409),
      );

      expect((await failureOf(fetchAccountExportFiles("clerk-token"))).reason).toBe("conflict");
    });
  });

  describe("account records", () => {
    it("returns the records as readable JSON text", async () => {
      const records = { version: 1, profile: [{ handle: "neo" }] };
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond(records));

      await expect(fetchAccountRecords("clerk-token")).resolves.toBe(JSON.stringify(records, null, 2));
      expect(fetchMock).toHaveBeenCalledWith(
        "https://app.matrix-os.com/api/account/delete/export/platform",
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("reports records that are not a JSON object as unavailable", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(respond("not records"));

      expect((await failureOf(fetchAccountRecords("clerk-token"))).reason).toBe("unavailable");
    });
  });
});
