// @vitest-environment jsdom

import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharingControls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@/components/projects/ProjectSharing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shell/src/components/projects/ProjectSharing.js")>();
  return {
    ...actual,
    ProjectSharingControl: (props: { projectId: string; projectName: string; runtimeId: string | null }) => {
      sharingControls.push(props);
      return <button type="button">Share project {props.projectName}</button>;
    },
  };
});

vi.mock("../../shell/src/components/terminal/TerminalThemePicker.js", () => ({
  ThemePickerButton: () => null,
}));

import { DesktopTerminalSidebar } from "../../shell/src/components/terminal/DesktopTerminalSidebar.js";
import type { ShellSessionSummary } from "../../shell/src/components/terminal/terminal-session-state.js";

const MACHINE_ID = "10000000-0000-4000-8000-000000000001";

function shell(name: string, subtitle: string, project?: string): ShellSessionSummary {
  return { name, subtitle, status: "active", ...(project ? { project, projectId: project } : {}) };
}

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

async function renderSidebar(sessions: ShellSessionSummary[]) {
  const view = render(<DesktopTerminalSidebar sessions={sessions} selectedName={null} creating={false}
    onCreate={vi.fn()} onOpen={vi.fn()} onDelete={vi.fn()} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

describe("DesktopTerminalSidebar project sharing (#1798)", () => {
  beforeEach(() => {
    sharingControls.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/system/info")) {
        return json({ runtime: { handle: "demo", runtimeSlot: "primary", machineId: MACHINE_ID }, capabilities: { collaboration: true } });
      }
      if (url.endsWith("/api/workspace/projects")) {
        return json({ projects: [
          { id: "proj_launch", slug: "launch-site", name: "Launch Site" },
          { id: "proj_docs", slug: "docs", name: "Docs" },
        ] });
      }
      return json({});
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("groups project sessions under the project name with its Share control", async () => {
    await renderSidebar([
      shell("tws_main:tt_1", "release-notes"),
      shell("tws_launch:tt_2", "api-server", "proj_launch"),
      shell("tws_launch:tt_3", "worker", "proj_launch"),
    ]);

    const group = screen.getByRole("group", { name: "Launch Site" });
    expect(within(group).getByRole("button", { name: "Share project Launch Site" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Open tws_launch:tt_2" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Open tws_launch:tt_3" })).toBeTruthy();
    const main = screen.getByRole("group", { name: "Main" });
    expect(within(main).getByRole("button", { name: "Open tws_main:tt_1" })).toBeTruthy();
    expect(within(main).queryByRole("button", { name: /^Share project/ })).toBeNull();
    expect(sharingControls.at(-1)).toEqual({ projectId: "proj_launch", projectName: "Launch Site", runtimeId: `vps:${MACHINE_ID}` });
  });

  it("resolves the runtime and project names once for every project heading", async () => {
    await renderSidebar([
      shell("tws_launch:tt_2", "api-server", "proj_launch"),
      shell("tws_docs:tt_4", "writer", "proj_docs"),
    ]);

    expect(screen.getByRole("group", { name: "Docs" })).toBeTruthy();
    const calls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(calls.filter((url) => url.endsWith("/api/system/info"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/api/workspace/projects"))).toHaveLength(1);
  });

  it("falls back to the project id when its name is unavailable", async () => {
    await renderSidebar([shell("tws_other:tt_5", "shell", "proj_unknown")]);

    expect(screen.getByRole("group", { name: "proj_unknown" })).toBeTruthy();
  });

  it("keeps the flat session list and fetches nothing when no session belongs to a project", async () => {
    await renderSidebar([shell("tws_main:tt_1", "release-notes"), shell("tws_main:tt_2", "notes")]);

    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Share project/ })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
