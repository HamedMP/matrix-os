// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectSetupControls, ProjectSetupEntry, ProjectSetupIntroduction } from "../../packages/ui/src/chat/ProjectSetupControls";
import {
  projectSetupGenerationText,
  projectSetupGenerationResultId,
} from "../../packages/ui/src/chat/project-setup-presentation";
import { ProjectSetupAcceptedNote } from "../../packages/ui/src/chat/ProjectSetupProgress";
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
    canAnswer: true,
    retryInterview: vi.fn(async () => true),
    pending: false,
    error: null,
    dispatch,
    start: vi.fn(async () => true),
    dismiss: vi.fn(),
    answer: vi.fn(async () => true),
    mcpHandoff: value.step === "review" && value.mcp.state === "pending",
    continueToReview: vi.fn(async () => true),
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

it("shows start progress without injecting a scripted question or suggestions", () => {
  const setup = controller();
  render(<ProjectSetupIntroduction projectName="Portfolio" setup={{ ...setup, draft: null, introduction: true, pending: true }} />);
  expect(screen.getByText("Project setup")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Starting project setup");
  expect(screen.queryByRole("button", { name: "A portfolio site" })).toBeNull();
});

it("renders only the Agent's suggestions through the same answer action", () => {
  const setup = controller(undefined, {
    ...draft, step: "guidance", proposals: [],
    interview: { focus: "intent", suggestions: ["Draft customer release notes", "Run a changelog review"] },
  });
  render(<ProjectSetupControls setup={setup} transport={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Draft customer release notes" }));
  expect(setup.answer).toHaveBeenCalledExactlyOnceWith("Draft customer release notes");
  expect(screen.queryByRole("button", { name: "Keep changes small" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect Linear" })).toBeNull();
});

it("shows one active question and keeps longer answers and the original context expandable", () => {
  const longAnswer = "Collect review feedback from the entire on-call rotation before changing the release process.";
  const replyText = "Let's set up your research project. I’ll help with release guidance and make it clear what you can leave to a later conversation.\n\nWhat should get reviewed? Who should sign off?";
  const setup = controller(undefined, {
    ...draft, step: "guidance", proposals: [],
    interview: { focus: "guidance", suggestions: [longAnswer, "Release notes", "Support docs"] },
  });
  render(<ProjectSetupControls setup={setup} transport={null} replyText={replyText} />);
  expect(screen.getByText("What should get reviewed?").closest("details")).toBeNull();
  expect(screen.getByText(/Who should sign off/).closest("details")?.open).toBe(false);
  expect(screen.getByText(/let.s set up your research project/i).closest("details")?.open).toBe(false);
  expect(screen.getByRole("button", { name: "Release notes" })).toBeTruthy();
  const longChoice = screen.getByText(longAnswer).closest("button")!;
  const choices = longChoice.closest("details")!;
  expect(choices.open).toBe(false);
  expect(choices.querySelector("summary")?.textContent).toBe("More answers");
  choices.open = true;
  fireEvent.click(longChoice);
  expect(setup.answer).toHaveBeenCalledExactlyOnceWith(longAnswer);
});

it("keeps a wide localized choice and a long service name fully actionable", () => {
  const service = "Atlassian (Jira, Confluence)";
  const answer = "发布时必须征求市场和合规团队的批准";
  const setup = controller(undefined, {
    ...draft, step: "mcp", proposals: [],
    interview: { focus: "mcp", suggestions: [answer], recommendedService: service },
  });
  render(<ProjectSetupControls setup={setup} transport={null} onOpenMcpSettings={vi.fn()} />);
  const serviceChoice = screen.getByText(`Connect ${service}`).closest("button")!;
  expect(serviceChoice.closest("details")?.open).toBe(false);
  expect(screen.getByText(answer).closest("details")?.open).toBe(false);
  serviceChoice.closest("details")!.open = true;
  fireEvent.click(serviceChoice);
  expect(setup.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "choose_mcp", choice: "connect", service });
});

const oversizedQuestion = "How should the release checklist handle overlapping requests from different teams when an approval arrives just before a deadline?";
it.each([
  [oversizedQuestion, oversizedQuestion],
  [`A quick note.\n\n${oversizedQuestion}`, oversizedQuestion],
  ["A quick note.\n\nWho owns the **final review**?", "Who owns the final review?"],
])("keeps an outlier question intact with an explicit read-and-reply fallback (%s)", (replyText, question) => {
  const setup = controller(undefined, {
    ...draft, step: "guidance", proposals: [],
    interview: { focus: "guidance", suggestions: [] },
  });
  render(<ProjectSetupControls setup={setup} transport={null} replyText={replyText} />);
  const details = screen.getByText("Read the agent’s question").closest("details")!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain(question);
});

it("reuses the confirmed MCP Settings flow only for the Agent's scoped recommendation", () => {
  const open = vi.fn();
  const dispatch = vi.fn(async () => true);
  render(<ProjectSetupControls setup={controller(dispatch, {
    ...draft, step: "review", interview: { focus: "review", suggestions: [], recommendedService: "GitHub" },
  })} transport={null} onOpenMcpSettings={open} />);
  fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "choose_mcp", choice: "connect", service: "GitHub" });
  expect(open).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Connect Linear" })).toBeNull();
});

it("keeps Save behind the review handoff and records an explicit MCP skip", () => {
  const open = vi.fn();
  const setup = controller(undefined, {
    ...draft,
    interview: { focus: "review", suggestions: [], recommendedService: "GitHub", mcpHandoff: true },
    mcp: { state: "pending", service: "GitHub" },
  });
  render(<ProjectSetupControls setup={setup} transport={null} onOpenMcpSettings={open} />);
  expect(screen.queryByRole("button", { name: "Save project setup" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open MCP Settings" }));
  expect(open).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Continue without connecting" }));
  expect(setup.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "choose_mcp", choice: "skip" });
  expect(setup.answer).not.toHaveBeenCalled();
});

it("finishes an approved tools-only setup without proposing files", () => {
  const dispatch = vi.fn(async () => true);
  render(<ProjectSetupControls setup={controller(dispatch, {
    ...draft, proposals: [], interview: { focus: "review", suggestions: [] },
  })} transport={null} />);
  expect(screen.queryByRole("button", { name: "Edit Markdown" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "save" });
});

it("keeps editing and save controls unavailable while the Agent is resolving a revision", () => {
  render(<ProjectSetupControls setup={controller(undefined, {
    ...draft, interview: { focus: "review", suggestions: [] }, generation: { status: "running" },
  })} transport={null} />);
  expect(screen.getByRole("status").textContent).toContain("Preparing the next reply");
  expect(screen.queryByRole("button", { name: "Save project setup" })).toBeNull();
});

it("asks for an explicit Settings handoff after choosing Linear", async () => {
  const open = vi.fn();
  const dispatch = vi.fn(async () => true);
  const { rerender } = render(
    <ProjectSetupControls setup={controller(dispatch, { ...draft, step: "mcp" })} transport={null} onOpenMcpSettings={open} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "choose_mcp", choice: "connect", service: "Linear" });
  expect(open).not.toHaveBeenCalled();

  rerender(
    <ProjectSetupControls
      setup={controller(dispatch, { ...draft, mcp: { state: "pending", service: "Linear" } })}
      transport={null}
      onOpenMcpSettings={open}
    />,
  );
  expect(screen.getByText("Awaiting MCP authorization")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save project setup" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open MCP Settings" }));
  expect(open).toHaveBeenCalledOnce();
  expect(screen.getByText("Awaiting MCP authorization")).toBeTruthy();
  expect(screen.queryByText("Linear is connected on this computer.")).toBeNull();
});

it("says the skill description is accepted without claiming that a skill file exists", () => {
  const current = { ...draft, step: "mcp" as const, answers: { ...draft.answers, skillInstructions: "Summarize a release" }, skill: undefined };
  render(<ProjectSetupAcceptedNote draft={current} />);
  expect(screen.getByText("Skill description added")).toBeTruthy();
  expect(screen.queryByText(/skill ready/i)).toBeNull();
});

it("can recover a generation that completes after polling stops without starting another run", () => {
  vi.useFakeTimers();
  try {
    const dispatch = vi.fn(async () => true);
    const running = { ...draft, generation: { runId: "run_draft", status: "running" as const } };
    const { rerender } = render(<ProjectSetupControls setup={controller(dispatch, running)} transport={null} />);
    act(() => vi.advanceTimersByTime(125_000));
    expect(dispatch).toHaveBeenCalledTimes(60);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save project setup" }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check draft status" }));
    expect(dispatch).toHaveBeenCalledTimes(61);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "sync_generation" });
    rerender(<ProjectSetupControls setup={controller(dispatch)} transport={null} />);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save project setup" }).disabled).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps an edited Markdown draft and blocks Save until its update is accepted", async () => {
  const dispatch = vi.fn(async () => false);
  render(<ProjectSetupControls setup={controller(dispatch)} transport={null} onOpenMcpSettings={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Portfolio" })).toBeTruthy();
  expect(screen.getByText("Run the tests.")).toBeTruthy();
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
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(screen.getByText("Ask before publishing.")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save project setup" }).disabled).toBe(true);
});

it("requires a ready enabled Settings connection before reporting connected", async () => {
  const current = { ...draft, mcp: { state: "pending" as const, service: "Linear" } };
  const get = vi.fn(async () => [
    { id: "mcp_linear", name: "Linear", url: "https://mcp.linear.app/mcp", status: "auth_required", enabled: true },
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
  get.mockResolvedValue([{ id: "mcp_linear", name: "Linear", url: "https://mcp.linear.app/mcp", status: "ready", enabled: true }]);
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  expect(await screen.findByText("Linear is connected on this computer.")).toBeTruthy();
});

it("does not report a same-named noncatalog Linear server as connected", async () => {
  const current = { ...draft, mcp: { state: "pending" as const, service: "Linear" } };
  const get = vi.fn(async () => [
    { id: "mcp_other", name: "Linear", url: "https://example.com/mcp", status: "ready", enabled: true },
  ]);
  render(
    <ProjectSetupControls
      setup={controller(undefined, current)}
      transport={{ get, post: vi.fn(), patch: vi.fn() }}
      onOpenMcpSettings={vi.fn()}
    />,
  );
  await waitFor(() => expect(get).toHaveBeenCalledOnce());
  expect(screen.queryByText("Linear is connected on this computer.")).toBeNull();
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
  const get = vi.fn(async () => [{ id: "mcp_linear", name: "Linear", url: "https://mcp.linear.app/mcp", status: "auth_required", enabled: true }]);
  const transport = { get, post: vi.fn(), patch: vi.fn() };
  const view = render(<ProjectSetupControls setup={setup} transport={transport} onOpenMcpSettings={vi.fn()} mcpSettingsOpen={false} />);
  await waitFor(() => expect(get).toHaveBeenCalledOnce());
  view.rerender(<ProjectSetupControls setup={setup} transport={transport} onOpenMcpSettings={vi.fn()} mcpSettingsOpen />);
  get.mockResolvedValue([{ id: "mcp_linear", name: "Linear", url: "https://mcp.linear.app/mcp", status: "ready", enabled: true }]);
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
  const existing = { ...draft, proposals: [{ path: "AGENTS.md" as const, content: "g".repeat(8193), status, expectedHash: null }] };
  const markdownEdits = { files: { "AGENTS.md": { value: "Stale draft", baseline: "Old draft", mode: "edit" as const } }, onChange: vi.fn() };
  render(<ProjectSetupControls setup={controller(undefined, existing)} transport={null} markdownEdits={markdownEdits} />);
  expect(screen.queryByRole("button", { name: "Edit Markdown" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Markdown for AGENTS.md" })).toBeNull();
  expect(screen.queryByText(/Shorten this draft before saving/)).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save project setup" }).disabled).toBe(false);
});

it.each([
  ["CLAUDE.md", "symlink_skipped", "Symbolic link preserved"],
  [".agents/skills/release-check/SKILL.md", "destination_unavailable", "Destination unavailable"],
] as const)("reports a blocked destination for %s and allows saving other proposals", (path, status, label) => {
  const setup = controller(undefined, { ...draft, proposals: [...draft.proposals,
    { path, status, content: "g".repeat(8193) }] });
  render(<ProjectSetupControls setup={setup} transport={null} onOpenFile={vi.fn()} />);
  expect(screen.queryByRole("region", { name: `Review ${path}` })).toBeNull();
  expect(screen.getByText(`${path} · ${label}`)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open file" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: status === "destination_unavailable" ? "Save available files" : "Save project setup" }));
  expect(setup.dispatch).toHaveBeenCalledWith({ type: "save" });
});
