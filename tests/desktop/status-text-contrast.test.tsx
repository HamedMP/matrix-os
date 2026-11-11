// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentThreadSummary, ProjectAgentWorkspace, RuntimeSummary } from "@matrix-os/contracts";
import { contrastRatio, getThemeChrome } from "../../packages/brand/src/themes";
import { chromeToSemanticVars } from "../../packages/brand/src/themes/desktop-theme";
import { ProjectThreadList } from "../../desktop/src/renderer/src/features/project/ProjectThreadList";
import { resolvedStyleColor } from "./theme-contrast-test-utils";

const AA_SMALL_TEXT = 4.5;
const MATRIX_VARIANTS = [
  ["matrix", "light"],
  ["matrix", "dark"],
  ["matrix-neon", "light"],
  ["matrix-neon", "dark"],
  // Nord dark once rendered --info-text at 4.46:1 on raised and hover surfaces.
  ["nord", "light"],
  ["nord", "dark"],
] as const;
const STATUSES = ["success", "warning", "danger", "info"] as const;
// Every surface a status label is rendered on in Electron Desktop.
const SURFACES = ["--bg-app", "--bg-surface", "--bg-raised", "--bg-overlay", "--bg-sunken", "--bg-hover", "--sidebar"] as const;

function varsFor(themeId: string, mode: "light" | "dark") {
  return chromeToSemanticVars(getThemeChrome(themeId, mode), themeId);
}

describe.each(MATRIX_VARIANTS)("%s %s status text contrast", (themeId, mode) => {
  const vars = varsFor(themeId, mode);

  it.each(STATUSES)("keeps --%s-text readable on its tint and on every surface", (status) => {
    const text = vars[`--${status}-text`]!;
    for (const background of [`--${status}-muted`, ...SURFACES]) {
      expect(contrastRatio(text, vars[background]!), `--${status}-text on ${background}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    }
  });

  it.each(STATUSES)("keeps text placed on the solid --%s fill readable", (status) => {
    expect(contrastRatio(vars[`--text-on-${status}`]!, vars[`--${status}`]!)).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
  });
});

const NOW = Date.parse("2026-07-15T12:00:00.000Z");

function thread(overrides: Partial<AgentThreadSummary>): AgentThreadSummary {
  return {
    id: "thread_x",
    providerId: "codex",
    title: "Some chat",
    status: "running",
    attention: "none",
    createdAt: "2026-07-15T11:00:00.000Z",
    updatedAt: "2026-07-15T11:55:00.000Z",
    ...overrides,
  } as AgentThreadSummary;
}

function workspace(): ProjectAgentWorkspace {
  return {
    project: { id: "matrix-os", label: "Matrix OS", status: "available", taskCount: 0, threadCount: 3, attentionCount: 1 },
    tasks: { items: [], hasMore: false, limit: 100 },
    projectThreads: {
      items: [
        thread({ id: "thread_wait", title: "Waiting chat", status: "waiting_for_approval", attention: "approval_required" }),
        thread({ id: "thread_done", title: "Done chat", status: "completed" }),
        thread({ id: "thread_fail", title: "Failed chat", status: "failed" }),
      ],
      hasMore: false,
      limit: 100,
    },
    taskThreads: { items: [], hasMore: false, limit: 100 },
    updatedAt: new Date(NOW).toISOString(),
  };
}

function renderThreadList(props: { status: "ready" | "error"; workspace: ProjectAgentWorkspace | null }) {
  render(
    <ProjectThreadList
      projectId="matrix-os"
      projectLabel="Matrix OS"
      summary={{
        providers: [],
        activeThreads: { items: [], hasMore: false, limit: 20 },
        attentionThreads: { items: [], hasMore: false, limit: 20 },
      } as unknown as RuntimeSummary}
      workspace={props.workspace}
      status={props.status}
      error={props.status === "error" ? "Project workspace unavailable" : null}
      selectedThreadId={null}
      canCreate
      onSelectThread={() => {}}
      onNewChat={() => {}}
      onRetry={() => {}}
    />,
  );
}

describe("ProjectThreadList status labels", () => {
  afterEach(cleanup);

  it.each(MATRIX_VARIANTS)("meets AA for Waiting, Done and Failed pills in %s %s", (themeId, mode) => {
    const vars = varsFor(themeId, mode);
    renderThreadList({ status: "ready", workspace: workspace() });
    for (const label of ["Waiting", "Done", "Failed"]) {
      const pill = screen.getByText(label, { selector: "span" });
      const ratio = contrastRatio(resolvedStyleColor(pill.style.color, vars), resolvedStyleColor(pill.style.background, vars));
      expect(ratio, `${label} pill`).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    }
  });

  it.each(MATRIX_VARIANTS)("meets AA for the workspace retry label in %s %s", (themeId, mode) => {
    const vars = varsFor(themeId, mode);
    renderThreadList({ status: "error", workspace: null });
    const retry = screen.getByRole("button", { name: "Retry loading the project workspace" });
    for (const surface of ["--bg-surface", "--sidebar"]) {
      expect(contrastRatio(resolvedStyleColor(retry.style.color, vars), vars[surface]!)).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    }
  });
});
