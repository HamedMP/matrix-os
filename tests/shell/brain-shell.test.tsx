// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shellApi } from "../../shell/src/api/http.js";
import { BrainApp, brainShellError, createBrainShellApi } from "../../shell/src/components/brain/index.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const PROJECT = "proj_matrix_os";

function answer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Company Brain on Web", () => {
  it("binds the shared view to the Web gateway client and shows its heading by default", async () => {
    const fetchMock = vi.fn(async () => answer(200, { projects: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<BrainApp active visible />);
    expect(screen.getByRole("heading", { level: 1, name: "Company Brain" })).toBeTruthy();
    expect(await screen.findByText("No projects yet.")).toBeTruthy();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("/api/workspace/projects");
  });

  it("hides the heading in a window that names the app", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(200, { projects: [] })));
    render(<BrainApp showHeading={false} active visible />);
    expect(await screen.findByText("No projects yet.")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("reads the Web client's errors with the shared reader", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(answer(404, { error: { code: "project_not_found" } }))
      .mockResolvedValueOnce(answer(503, { error: "brain_unavailable" }))
      .mockResolvedValueOnce(answer(409, { error: { code: "revision_conflict", message: "secret" } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = createBrainShellApi(shellApi);
    const failure = (call: Promise<unknown>) => call.then(() => null, (error: unknown) => brainShellError(error));
    expect(await failure(api.sources(PROJECT))).toEqual({ kind: "not_found", code: "project_not_found" });
    expect(await failure(api.sources(PROJECT))).toEqual({ kind: "unavailable" });
    expect(await failure(api.updateSource(PROJECT, "src_1", { expectedRevision: 1, status: "paused" })))
      .toEqual({ kind: "rejected", code: "revision_conflict" });
  });

  it("removes a source with the Web delete call, which sends no body", async () => {
    const remove = vi.spyOn(shellApi, "delete").mockResolvedValue({ removed: true });
    await createBrainShellApi(shellApi).removeSource(PROJECT, "src_1", 3);
    expect(remove).toHaveBeenCalledWith(
      `/api/brain/projects/${PROJECT}/sources/src_1?expectedRevision=3`, { timeoutMs: 15_000 },
    );
  });
});
