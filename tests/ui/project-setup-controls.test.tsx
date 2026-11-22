// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectSetupControls, ProjectSetupEntry } from "../../packages/ui/src/chat/ProjectSetupControls";
import {
  projectSetupGenerationText,
  projectSetupGenerationResultId,
} from "../../packages/ui/src/chat/project-setup-presentation";
import type { ProjectSetupController } from "../../packages/ui/src/chat/use-project-setup";
import type { ProjectSetupDraft } from "@matrix-os/contracts";

afterEach(cleanup);
const draft: ProjectSetupDraft = {
  chatId: "chat_setup",
  projectId: "project_a",
  revision: 1,
  step: "review",
  currentQuestionMessageId: "msg_question",
  answers: { purpose: "Portfolio", guidance: "Run tests" },
  proposals: [{ path: "AGENTS.md", content: "# Portfolio\n\nRun the tests.\n", status: "pending" }],
  mcp: { state: "skipped" },
  generation: { runId: "run_draft", status: "completed" },
  updatedAt: "2026-11-22T12:00:00Z",
};
function controller(dispatch = vi.fn(async () => true), value = draft): ProjectSetupController {
  return {
    identity: "owner:computer:project_a",
    draft: value,
    eligible: true,
    introduction: false,
    active: true,
    pending: false,
    error: null,
    dispatch,
    start: vi.fn(async () => true),
    dismiss: vi.fn(),
    answer: vi.fn(async () => true),
    reload: vi.fn(async () => true),
  };
}

it("allows skipping the setup offer without starting Chat", () => {
  const start = vi.fn();
  render(<ProjectSetupEntry onStart={start} />);
  fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Set up with Chat" }));
  expect(start).toHaveBeenCalledOnce();
});

it("keeps an edited Markdown draft and blocks Save until its update is accepted", async () => {
  const dispatch = vi.fn(async () => false);
  render(<ProjectSetupControls setup={controller(dispatch)} transport={null} onOpenMcpSettings={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Markdown for AGENTS.md" }), {
    target: { value: "# Portfolio\n\nAsk before publishing." },
  });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save project setup" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Apply draft changes" }));
  await waitFor(() =>
    expect(dispatch).toHaveBeenCalledWith({
      type: "review_file",
      path: "AGENTS.md",
      content: "# Portfolio\n\nAsk before publishing.",
    }),
  );
  expect(screen.getByRole("textbox", { name: "Markdown for AGENTS.md" })).toHaveProperty(
    "value",
    "# Portfolio\n\nAsk before publishing.",
  );
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save project setup" }).disabled).toBe(true);
});

it("requires a ready enabled Settings connection before reporting connected", async () => {
  const current = { ...draft, mcp: { state: "pending" as const, service: "Linear" } };
  const get = vi.fn(async () => [
    { id: "mcp_linear", name: "Linear", status: "auth_required", enabled: true },
  ]);
  render(
    <ProjectSetupControls
      setup={controller(undefined, current)}
      transport={{ get, post: vi.fn(), patch: vi.fn() }}
      onOpenMcpSettings={vi.fn()}
    />,
  );
  await waitFor(() => expect(get).toHaveBeenCalled());
  expect(screen.queryByText("Linear is connected on this computer.")).toBeNull();
  get.mockResolvedValue([{ id: "mcp_linear", name: "Linear", status: "ready", enabled: true }]);
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  expect(await screen.findByText("Linear is connected on this computer.")).toBeTruthy();
});

it("projects only the exact setup generation run into a normal assistant reply", () => {
  expect(projectSetupGenerationText(draft, "run_unrelated")).toBeNull();
  expect(projectSetupGenerationText(draft, "run_draft")).toBe(
    "I drafted your project guidance. Review the Markdown below before saving.",
  );
});

it("reports generation failure accurately instead of showing progress", () => {
  const failed = { ...draft, generation: { runId: "run_draft", status: "failed" as const } };
  expect(projectSetupGenerationText(failed, "run_draft")).toBe(
    "I couldn’t draft your project files. Your answers are kept. Choose a supported model and try again.",
  );
});

it("stages an imported manifest without issuing a save action", async () => {
  const dispatch = vi.fn(async () => true);
  const skillDraft = { ...draft, step: "skill" as const, proposals: [], generation: undefined };
  render(
    <ProjectSetupControls
      setup={controller(dispatch, skillDraft)}
      transport={null}
      onOpenMcpSettings={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Import SKILL.md" }));
  const content = "---\nname: release-check\ndescription: Review a release\n---\n\nRun the relevant tests.\n";
  const bytes = new TextEncoder().encode(content);
  const file = new File([bytes], "SKILL.md", { type: "text/markdown" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  fireEvent.change(screen.getByLabelText("SKILL.md file"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Import skill" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "stage_skill", content }));
});

it("projects one final result and preserves earlier assistant commentary and tool evidence", () => {
  const messages = [
    { id: "msg_commentary", role: "assistant", runId: "run_draft" },
    { id: "msg_tool", role: "tool", runId: "run_draft" },
    { id: "msg_result", role: "assistant", runId: "run_draft" },
    { id: "msg_unrelated", role: "assistant", runId: "run_other" },
  ];
  expect(projectSetupGenerationResultId(draft, messages)).toBe("msg_result");
});

it("offers a safe reload after a stale or failed mutation while preserving local Markdown edits", async () => {
  const setup = controller();
  setup.error = "Project setup could not be updated. Your answers are kept. Try again.";
  render(<ProjectSetupControls setup={setup} transport={null} onOpenMcpSettings={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Markdown for AGENTS.md" }), { target: { value: "# My unsaved change" } });
  fireEvent.click(screen.getByRole("button", { name: "Reload setup" }));
  await waitFor(() => expect(setup.reload).toHaveBeenCalledOnce());
  expect(screen.getByRole("textbox", { name: "Markdown for AGENTS.md" })).toHaveProperty("value", "# My unsaved change");
});

it("refreshes authoritative MCP status when the in-app Settings overlay closes", async () => {
  const current = { ...draft, mcp: { state: "pending" as const, service: "Linear" } };
  const setup = controller(undefined, current);
  const get = vi.fn(async () => [{ id: "mcp_linear", name: "Linear", status: "auth_required", enabled: true }]);
  const transport = { get, post: vi.fn(), patch: vi.fn() };
  const view = render(<ProjectSetupControls setup={setup} transport={transport} onOpenMcpSettings={vi.fn()} mcpSettingsOpen={false} />);
  await waitFor(() => expect(get).toHaveBeenCalledOnce());
  view.rerender(<ProjectSetupControls setup={setup} transport={transport} onOpenMcpSettings={vi.fn()} mcpSettingsOpen />);
  get.mockResolvedValue([{ id: "mcp_linear", name: "Linear", status: "ready", enabled: true }]);
  view.rerender(<ProjectSetupControls setup={setup} transport={transport} onOpenMcpSettings={vi.fn()} mcpSettingsOpen={false} />);
  expect(await screen.findByText("Linear is connected on this computer.")).toBeTruthy();
  expect(get).toHaveBeenCalledTimes(2);
});

it.each(["pending", "conflict", "failed"] as const)("keeps oversized %s guidance reviewable and blocks Save until it is revised", (status) => {
  const oversized = { ...draft, proposals: [{ path: "AGENTS.md" as const, content: "g".repeat(8193), status }] };
  render(<ProjectSetupControls setup={controller(undefined, oversized)} transport={null} onOpenMcpSettings={vi.fn()} />);
  expect(screen.getByText("8193 / 8192 characters. Shorten this draft before saving.")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save project setup" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Edit Markdown" }));
  expect(screen.getByRole("textbox", { name: "Markdown for AGENTS.md" })).toHaveProperty("value", "g".repeat(8193));
  fireEvent.change(screen.getByRole("textbox", { name: "Markdown for AGENTS.md" }), { target: { value: "# Shortened guidance" } });
  expect(screen.queryByText(/Shorten this draft before saving/)).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save project setup" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply draft changes" }).disabled).toBe(false);
});

it.each(["saved", "already_present"] as const)("allows a preserved %s guidance file beyond the new-file creation limit", (status) => {
  const existing = { ...draft, proposals: [{ path: "AGENTS.md" as const, content: "g".repeat(8193), status }] };
  render(<ProjectSetupControls setup={controller(undefined, existing)} transport={null} onOpenMcpSettings={vi.fn()} />);
  expect(screen.queryByText(/Shorten this draft before saving/)).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save project setup" }).disabled).toBe(false);
});
