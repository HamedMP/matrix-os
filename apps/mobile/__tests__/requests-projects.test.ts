import {
  archiveProject,
  createProject,
  ProjectRequestError,
  renameProject,
} from "@/lib/requests/projects";

const gatewayUrl = "https://app.matrix-os.com/vm/alice";
const token = "clerk-token";

// What the gateway stores for a project (ProjectConfig); only part of it is kept.
const serverProject = {
  id: "proj_0f8fad5b-d9cb-469f-a165-70867728950e",
  name: "Field notes",
  slug: "field-notes",
  kind: "scratch",
  localPath: "/home/matrix/home/projects/field-notes/repo",
  addedAt: "2026-10-08T09:00:00.000Z",
  updatedAt: "2026-10-08T09:00:00.000Z",
  ownerScope: { type: "user", id: "user_a" },
};
const summary = { id: serverProject.id, name: "Field notes", slug: "field-notes", kind: "scratch" };

function respond(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function refusal(code: string, status: number): Response {
  return respond({ error: { code, message: "Server wording that must not reach the screen" } }, status);
}

async function failureOf(request: Promise<unknown>): Promise<ProjectRequestError> {
  try {
    await request;
  } catch (error: unknown) {
    if (error instanceof ProjectRequestError) return error;
    throw error;
  }
  throw new Error("Expected the request to fail");
}

function sentBody(fetchMock: jest.SpyInstance): unknown {
  return JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
}

describe("project requests", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("createProject", () => {
    it("posts the name to the workspace route with the session token and a timeout", async () => {
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond({ project: serverProject }, 201));

      await expect(createProject(token, gatewayUrl, { name: "Field notes" })).resolves.toEqual(summary);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://app.matrix-os.com/vm/alice/api/projects",
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: "Bearer clerk-token", "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Field notes" }),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("trims the name and passes on a request id, so a repeated attempt returns the same project", async () => {
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond({ project: serverProject }, 200));

      await createProject(token, gatewayUrl, { name: "  Field notes ", clientRequestId: "req_abc123" });

      expect(sentBody(fetchMock)).toEqual({ name: "Field notes", clientRequestId: "req_abc123" });
    });

    it.each([
      ["an empty name", ""],
      ["a name of only spaces", "   "],
      ["a name longer than the server accepts", "n".repeat(129)],
    ])("refuses %s without calling the server", async (_label, name) => {
      const fetchMock = jest.spyOn(global, "fetch");

      expect((await failureOf(createProject(token, gatewayUrl, { name }))).reason).toBe("invalid_name");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a malformed request id without calling the server", async () => {
      const fetchMock = jest.spyOn(global, "fetch");

      const failure = await failureOf(createProject(token, gatewayUrl, { name: "Field notes", clientRequestId: "nope" }));

      expect(failure.reason).toBe("unavailable");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports a taken name from the conflict code, not from the server's wording", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(refusal("slug_conflict", 409));

      const failure = await failureOf(createProject(token, gatewayUrl, { name: "Field notes" }));

      expect(failure.reason).toBe("name_taken");
      expect(failure.message).not.toContain("Server wording");
    });

    it("reports a name the server rejects as invalid", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(refusal("invalid_slug", 400));

      expect((await failureOf(createProject(token, gatewayUrl, { name: "Field notes" }))).reason).toBe("invalid_name");
    });

    it.each([401, 403, 413, 500, 503])("reports HTTP %s as unavailable", async (status) => {
      jest.spyOn(global, "fetch").mockResolvedValue(respond({ error: "postgres://internal detail" }, status));

      const failure = await failureOf(createProject(token, gatewayUrl, { name: "Field notes" }));

      expect(failure.reason).toBe("unavailable");
      expect(failure.message).not.toContain("postgres");
    });

    it("reports a network failure as unavailable", async () => {
      jest.spyOn(global, "fetch").mockRejectedValue(new TypeError("Network request failed"));

      expect((await failureOf(createProject(token, gatewayUrl, { name: "Field notes" }))).reason).toBe("unavailable");
    });

    it("reports a response without a usable project as unavailable", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(respond({ project: { id: "", slug: "field-notes" } }, 201));

      expect((await failureOf(createProject(token, gatewayUrl, { name: "Field notes" }))).reason).toBe("unavailable");
    });

    it("does not call the server without a session token or with an invalid gateway address", async () => {
      const fetchMock = jest.spyOn(global, "fetch");

      expect((await failureOf(createProject(" ", gatewayUrl, { name: "Field notes" }))).reason).toBe("unavailable");
      expect((await failureOf(createProject(token, "not a url", { name: "Field notes" }))).reason).toBe("unavailable");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("renameProject", () => {
    it("patches only the name of the project with that slug", async () => {
      const renamed = { ...serverProject, name: "Trip notes" };
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(respond({ project: renamed }));

      await expect(renameProject(token, gatewayUrl, "field-notes", " Trip notes ")).resolves.toEqual({
        ...summary,
        name: "Trip notes",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://app.matrix-os.com/vm/alice/api/projects/field-notes",
        expect.objectContaining({
          method: "PATCH",
          headers: { Authorization: "Bearer clerk-token", "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Trip notes" }),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it.each([
      ["an empty name", "field-notes", " "],
      ["a slug the server would not route", "Field Notes/../x", "Trip notes"],
    ])("refuses %s without calling the server", async (_label, slug, name) => {
      const fetchMock = jest.spyOn(global, "fetch");

      await failureOf(renameProject(token, gatewayUrl, slug, name));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("tells an invalid name apart from an invalid project reference", async () => {
      jest.spyOn(global, "fetch");

      expect((await failureOf(renameProject(token, gatewayUrl, "field-notes", ""))).reason).toBe("invalid_name");
      expect((await failureOf(renameProject(token, gatewayUrl, "Not A Slug", "Trip notes"))).reason).toBe("not_found");
    });

    it.each([
      [400, "invalid_request", "invalid_name"],
      [404, "not_found", "not_found"],
      [409, "project_changed", "conflict"],
      [409, "project_shared", "conflict"],
      [500, "update_failed", "unavailable"],
      [503, "project_unavailable", "unavailable"],
    ] as const)("maps HTTP %s %s to %s", async (status, code, reason) => {
      jest.spyOn(global, "fetch").mockResolvedValue(refusal(code, status));

      expect((await failureOf(renameProject(token, gatewayUrl, "field-notes", "Trip notes"))).reason).toBe(reason);
    });
  });

  describe("archiveProject", () => {
    it("posts the archive action and returns the archived project", async () => {
      const archived = { ...serverProject, archivedAt: "2026-10-08T10:00:00.000Z" };
      const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
        respond({ ok: true, action: "archive", project: archived }),
      );

      await expect(archiveProject(token, gatewayUrl, "field-notes")).resolves.toEqual({
        ...summary,
        archivedAt: "2026-10-08T10:00:00.000Z",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://app.matrix-os.com/vm/alice/api/projects/field-notes/actions",
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: "Bearer clerk-token", "Content-Type": "application/json" },
          body: JSON.stringify({ type: "archive" }),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("reports work still running in the project as its own reason", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(refusal("project_active", 409));

      const failure = await failureOf(archiveProject(token, gatewayUrl, "field-notes"));

      expect(failure.reason).toBe("project_active");
      expect(failure.message).not.toContain("Server wording");
    });

    it("does not mistake another conflict for running work", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(refusal("project_shared", 409));

      expect((await failureOf(archiveProject(token, gatewayUrl, "field-notes"))).reason).toBe("conflict");
    });

    it("still reports a conflict when the conflict body is not JSON", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 409,
        json: jest.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
      } as unknown as Response);

      expect((await failureOf(archiveProject(token, gatewayUrl, "field-notes"))).reason).toBe("conflict");
    });

    it.each([
      [404, "not_found", "not_found"],
      [500, "activity_check_failed", "unavailable"],
    ] as const)("maps HTTP %s %s to %s", async (status, code, reason) => {
      jest.spyOn(global, "fetch").mockResolvedValue(refusal(code, status));

      expect((await failureOf(archiveProject(token, gatewayUrl, "field-notes"))).reason).toBe(reason);
    });

    it("reports an answer for a different action as unavailable", async () => {
      jest.spyOn(global, "fetch").mockResolvedValue(respond({ ok: true, action: "delete", projectSlug: "field-notes" }));

      expect((await failureOf(archiveProject(token, gatewayUrl, "field-notes"))).reason).toBe("unavailable");
    });
  });
});
