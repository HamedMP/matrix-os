// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REPOS_RESPONSE = {
  repos: [
    {
      nameWithOwner: "acme/api",
      url: "https://github.com/acme/api",
      description: "API",
      primaryLanguage: "TypeScript",
      stargazerCount: 1200,
      updatedAt: "2026-06-20T00:00:00Z",
    },
  ],
};

async function load() {
  vi.resetModules();
  return await import(
    "../../shell/src/components/onboarding/steps/RepoStep.js"
  );
}

describe("RepoStep (expanded)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let onChangeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    onChangeMock = vi.fn();

    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/github/repos")) {
          return new Response(JSON.stringify(REPOS_RESPONSE), { status: 200 });
        }
        if (url.includes("/api/projects")) {
          return new Response(JSON.stringify({ id: "proj_1" }), {
            status: 201,
          });
        }
        return new Response("{}", { status: 200 });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the repo row from /api/github/repos when expanded", async () => {
    const { RepoStep } = await load();
    render(
      <RepoStep
        title="Clone or import a repo"
        status="active"
        expanded
        onChange={onChangeMock}
      />,
    );

    // Repo list should appear after the async fetch resolves.
    await waitFor(() => {
      expect(screen.getByText("acme/api")).toBeTruthy();
    });
  });

  it("POSTs /api/projects with the repo url and calls onChange on 201", async () => {
    const { RepoStep } = await load();
    render(
      <RepoStep
        title="Clone or import a repo"
        status="active"
        expanded
        onChange={onChangeMock}
      />,
    );

    // Wait for the repo row to appear
    await waitFor(() => {
      expect(screen.getByText("acme/api")).toBeTruthy();
    });

    // Click the per-row Clone button
    const cloneBtn = screen.getByRole("button", {
      name: /clone acme\/api/i,
    });
    fireEvent.click(cloneBtn);

    await waitFor(() => {
      expect(onChangeMock).toHaveBeenCalledTimes(1);
    });

    // Verify the POST was made with the correct url
    const projectCalls = fetchSpy.mock.calls.filter((args) =>
      String(args[0]).includes("/api/projects"),
    );
    expect(projectCalls.length).toBe(1);
    const [, init] = projectCalls[0];
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ url: "https://github.com/acme/api" });
  });

  it("does not call onChange when the POST returns a non-201 status", async () => {
    // Override to return 500 for projects endpoint
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/github/repos")) {
        return new Response(JSON.stringify(REPOS_RESPONSE), { status: 200 });
      }
      if (url.includes("/api/projects")) {
        return new Response(JSON.stringify({ error: "server_error" }), {
          status: 500,
        });
      }
      return new Response("{}", { status: 200 });
    });

    const { RepoStep } = await load();
    render(
      <RepoStep
        title="Clone or import a repo"
        status="active"
        expanded
        onChange={onChangeMock}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("acme/api")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /clone acme\/api/i }));

    // onChange should NOT be called
    await waitFor(() => {
      expect(screen.getByText(/could not clone/i)).toBeTruthy();
    });
    expect(onChangeMock).not.toHaveBeenCalled();
  });
});
