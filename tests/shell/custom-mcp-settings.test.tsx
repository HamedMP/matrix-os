// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomMcpServersPanel } from "../../shell/src/components/settings/sections/CustomMcpServersPanel";

describe("Canvas Custom MCP management", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("serializes rapid tool edits onto the latest optimistic revision", async () => {
    let releaseFirstPatch!: () => void;
    const firstPatchGate = new Promise<void>((resolve) => { releaseFirstPatch = resolve; });
    let revision = 1;
    let server = {
      id: "6bc45f4b-cf18-43ac-a424-c199a43511f4",
      name: "Research",
      url: "https://mcp.acme.tools/mcp",
      authMode: "none",
      status: "disabled",
      enabled: false,
      revision,
      tools: [
        { name: "search", description: "", inputSchema: {}, approval: "always_ask", enabled: false },
        { name: "summarize", description: "", inputSchema: {}, approval: "always_ask", enabled: false },
      ],
    };
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return Response.json([server]);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ method, body });
      if (requests.length === 1) await firstPatchGate;
      revision += 1;
      server = { ...server, ...body, revision } as typeof server;
      return Response.json(server);
    });
    render(<CustomMcpServersPanel />);
    const checkboxes = await screen.findAllByRole("checkbox");

    fireEvent.click(checkboxes[0]!);
    fireEvent.click(checkboxes[1]!);
    releaseFirstPatch();

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.body).toMatchObject({
      revision: 2,
      tools: [
        { name: "search", enabled: true },
        { name: "summarize", enabled: true },
      ],
    });
  });

  it("rebases local policy edits after a revision conflict and retries once", async () => {
    let server = {
      id: "6bc45f4b-cf18-43ac-a424-c199a43511f4",
      name: "Research",
      url: "https://mcp.acme.tools/mcp",
      authMode: "none",
      status: "disabled",
      enabled: false,
      revision: 1,
      tools: [{ name: "search", description: "", inputSchema: {}, approval: "always_ask", enabled: false }],
    };
    let getCount = 0;
    const patchBodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        getCount += 1;
        if (getCount === 2) server = { ...server, revision: 2 };
        return Response.json([server]);
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      patchBodies.push(body);
      if (patchBodies.length === 1) return Response.json({ error: "Revision conflict" }, { status: 409 });
      server = { ...server, ...body, revision: 3 } as typeof server;
      return Response.json(server);
    });
    render(<CustomMcpServersPanel />);

    fireEvent.click((await screen.findAllByRole("checkbox"))[0]!);

    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies[1]).toMatchObject({
      revision: 2,
      tools: [{ name: "search", enabled: true, approval: "always_ask" }],
    });
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
