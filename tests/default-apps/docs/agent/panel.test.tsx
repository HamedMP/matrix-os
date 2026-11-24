// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocsAgentPanel } from "../../../../home/apps/docs/src/ui/agent/DocsAgentPanel";
import type { DocumentEditorController } from "../../../../home/apps/docs/src/editor/index";
import type { DocumentSession } from "../../../../home/apps/docs/src/session/index";
import { contractSession, envelope, finalText, scripted } from "./helpers";

afterEach(cleanup);

/** The part of the editor controller the panel uses, recording jumps. */
function fakeEditor(selection: { start: { blockId: string; offset: number }; end: { blockId: string; offset: number } } | null = null) {
  const jumps: unknown[] = [];
  const snapshot = {
    viewMode: "markup",
    readOnly: false,
    focused: false,
    selection: selection && { anchor: selection.start, focus: selection.end, start: selection.start, end: selection.end, collapsed: false, backward: false },
    activeFormat: null,
  };
  const editor = {
    getSelection: () => snapshot.selection,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    setSelection: vi.fn((target: unknown) => {
      jumps.push(target);
      return true;
    }),
    scrollTo: vi.fn((target: unknown) => {
      jumps.push(target);
    }),
  };
  return { editor: editor as unknown as DocumentEditorController, jumps };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderPanel(session: DocumentSession, generate: (input: { prompt: string }) => Promise<{ text: string }>, editor: DocumentEditorController | null = null) {
  return render(<DocsAgentPanel session={session} editor={editor} generate={generate} onClose={() => undefined} />);
}

describe("<DocsAgentPanel>", () => {
  it("runs a quick action and lists the proposed revisions; Accept all accepts them", async () => {
    const { session } = await contractSession();
    const model = scripted(envelope([{ op: "replaceText", blockId: "b25", find: "24 months", replace: "36 months" }], "Extends the term."));
    const { editor, jumps } = fakeEditor();
    renderPanel(session, model.generate, editor);
    for (const label of ["Tighten", "Proofread", "Summarise", "Review against instructions"]) expect(screen.getByRole("button", { name: label })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Tighten" }));
    await flush();
    expect(model.prompts[0]).toContain("Tighten the wording");
    const card = screen.getByRole("article", { name: "Tighten" });
    expect(within(card).getByText("Extends the term.")).toBeTruthy();
    expect(within(card).getByText("1 revision")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Replaced “24” with “36”" }));
    expect(jumps).toHaveLength(1);
    expect(jumps[0]).toMatchObject({ start: { blockId: "b25" } });

    fireEvent.click(within(card).getByRole("button", { name: "Accept all" }));
    expect(session.requireDocument().listRevisions()).toEqual([]);
    expect(finalText(session.requireDocument())).toContain("initial period of 36 months");
    expect(within(screen.getByRole("article", { name: "Tighten" })).getByText("Accepted")).toBeTruthy();
  });

  it("Reject all restores the original text", async () => {
    const { session } = await contractSession();
    const before = finalText(session.requireDocument());
    const model = scripted(envelope([{ op: "replaceText", blockId: "b25", find: "24 months", replace: "36 months" }]));
    renderPanel(session, model.generate);
    fireEvent.change(screen.getByLabelText("Ask the agent"), { target: { value: "Make the term 36 months" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Reject all" }));
    expect(finalText(session.requireDocument())).toBe(before);
    expect(screen.getByText("Rejected")).toBeTruthy();
  });

  it("reviews proposed revisions one by one", async () => {
    const { session } = await contractSession();
    const model = scripted(
      envelope([
        { op: "replaceText", blockId: "b25", find: "24 months", replace: "36 months" },
        { op: "replaceText", blockId: "b26", find: "90 days’", replace: "60 days’" },
      ]),
    );
    const { editor, jumps } = fakeEditor();
    renderPanel(session, model.generate, editor);
    fireEvent.change(screen.getByLabelText("Ask the agent"), { target: { value: "Change the term and notice" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Review one by one" }));
    const bar = screen.getByRole("toolbar", { name: "Review revisions" });
    expect(within(bar).getByText("1 of 2")).toBeTruthy();
    expect(jumps.at(-1)).toMatchObject({ start: { blockId: "b25" } });

    fireEvent.click(within(bar).getByRole("button", { name: "Accept revision" }));
    expect(within(screen.getByRole("toolbar", { name: "Review revisions" })).getByText("1 of 1")).toBeTruthy();
    expect(jumps.at(-1)).toMatchObject({ start: { blockId: "b26" } });
    fireEvent.click(within(screen.getByRole("toolbar", { name: "Review revisions" })).getByRole("button", { name: "Reject revision" }));
    expect(screen.queryByRole("toolbar", { name: "Review revisions" })).toBeNull();
    const text = finalText(session.requireDocument());
    expect(text).toContain("36 months");
    expect(text).toContain("at least 90 days’ written notice");
    expect(screen.getByText(/1 accepted, 1 rejected/)).toBeTruthy();
  });

  it("answers in Ask mode with clickable citations", async () => {
    const { session } = await contractSession();
    const model = scripted("Invoices are due within 30 days [b38].");
    const { editor, jumps } = fakeEditor();
    renderPanel(session, model.generate, editor);
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.change(screen.getByLabelText("Ask the agent"), { target: { value: "When are invoices due?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await flush();
    expect(model.prompts[0]).toContain("Answer the owner's question");
    fireEvent.click(screen.getByRole("button", { name: "Go to source 1" }));
    expect(jumps.at(-1)).toBe("b38");
    expect(session.requireDocument().listRevisions()).toEqual([]);
  });

  it("Review against instructions adds comments only", async () => {
    const { session } = await contractSession();
    const model = scripted(envelope([{ op: "comment", blockId: "b38", find: "within 30 days of receipt", text: "Instructions require 45 days." }]));
    renderPanel(session, model.generate);
    fireEvent.click(screen.getByRole("button", { name: "Review against instructions" }));
    expect(screen.getByText(/comment wherever the draft deviates/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Ask the agent"), { target: { value: "Payment within 45 days." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await flush();
    expect(model.prompts[0]).toContain('Use only "comment" edits');
    expect(session.requireDocument().listComments()).toHaveLength(1);
    expect(session.requireDocument().listRevisions()).toEqual([]);
    expect(screen.getByRole("button", { name: /Comment on “within 30 days of receipt”/ })).toBeTruthy();
  });

  it("explains the selection and fixes numbering from the toolbar", async () => {
    const { session } = await contractSession();
    const model = scripted("It caps liability [b50].");
    const { editor } = fakeEditor({ start: { blockId: "b50", offset: 0 }, end: { blockId: "b50", offset: 30 } });
    renderPanel(session, model.generate, editor);
    fireEvent.click(screen.getByRole("button", { name: "Explain selection" }));
    await flush();
    expect(model.prompts[0]).toContain("Explain the selected text");
    expect(screen.getByRole("article", { name: "Explanation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fix numbering" }));
    expect(screen.getByRole("article", { name: "Numbering fixes" })).toBeTruthy();
    expect(session.requireDocument().listComments().length).toBeGreaterThanOrEqual(1);
  });

  it("shows a generic message when the model fails and when it is unavailable", async () => {
    const { session } = await contractSession();
    const model = scripted(new Error("provider 500: internal detail"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderPanel(session, model.generate);
    fireEvent.click(screen.getByRole("button", { name: "Proofread" }));
    await flush();
    expect(screen.getByText("The assistant is unavailable right now. Try again.")).toBeTruthy();
    expect(screen.queryByText(/internal detail/)).toBeNull();
    cleanup();
    render(<DocsAgentPanel session={session} editor={null} />);
    expect(screen.getByText("The assistant needs AI access, which is not available here.")).toBeTruthy();
    warn.mockRestore();
  });
});
