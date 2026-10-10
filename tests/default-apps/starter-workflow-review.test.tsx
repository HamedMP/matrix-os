// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import catalog from "../../home/system/app-gallery.json";
import ExistingWorkflows from "../../home/app-templates/connected-starter/src/ExistingWorkflows";
import NewWorkflows from "../../home/app-templates/connected-starter/src/workflows/NewWorkflows";
import Focus from "../../home/app-templates/connected-starter/src/views/Focus";
import Habits from "../../home/app-templates/connected-starter/src/views/Habits";
import { interviewPacket, sourceQuestions } from "../../home/app-templates/connected-starter/src/workflows/models";
import type { Definition, OwnerRecord } from "../../home/app-templates/connected-starter/src/types";
const row = (id: string, fields: OwnerRecord["fields"], scope: "personal" | "work" = "personal"): OwnerRecord => ({ id, fields, scope, accounts: [], sources: [], manualFields: [], updatedAt: "2026-10-08" });
const props = (id: string, records: OwnerRecord[] = []) => ({ app: catalog.apps.find(app => app.id === id) as Definition, records, onEdit: vi.fn(), onEvidence: vi.fn(), onAdd: vi.fn(), onSave: vi.fn(async (_record: OwnerRecord) => {}) });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("completed focus sessions inherit the selected Work group", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const p = props("focus");
  render(<Focus {...p} creationScope="work" />);
  fireEvent.change(screen.getByLabelText("Focus task"), { target: { value: "Work research" } });
  fireEvent.click(screen.getByRole("button", { name: "Begin focus" }));
  act(() => vi.advanceTimersByTime(25 * 60 * 1000));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Log completed session" })));
  expect(p.onSave.mock.calls[0][0].scope).toBe("work");
});
it.each([
  ["atlas", "Preparation note for Original", "Save preparation", "preparation"],
  ["meeting-briefs", "Actions for Original", "Save actions", "actions"],
])("%s retains dirty text and its record identity across outer filters", async (id, label, button, field) => {
  const original = row("original", { title: "Original", [field]: "Saved text" });
  const other = row("other", { title: "Other", [field]: "Other saved text" }, "work");
  const p = props(id, [original, other]);
  const view = render(<ExistingWorkflows {...p} />);
  fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value: "Unsaved owner text" } });
  view.rerender(<ExistingWorkflows {...p} records={[other]} />);
  expect(screen.getByRole("textbox", { name: label })).toHaveProperty("value", "Unsaved owner text");
  view.rerender(<ExistingWorkflows {...p} records={[]} />);
  fireEvent.click(screen.getByRole("button", { name: button }));
  await waitFor(() => expect(p.onSave).toHaveBeenCalled());
  expect(p.onSave.mock.calls[0][0]).toMatchObject({ id: "original", scope: "personal", fields: { [field]: "Unsaved owner text" } });
});
it("interview packets reopen completely without changing original notes or nesting the packet", async () => {
  const original = row("application", { title: "Designer", company: "Studio", stage: "Applied", notes: "Original source notes", resume: "Owned resume" });
  const p = props("job-search", [original]);
  const view = render(<NewWorkflows {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Prepare interview packet" }));
  const packet = "Complete preparation " + "x".repeat(9000) + " essential final question";
  fireEvent.change(screen.getByLabelText("Packet and preparation"), { target: { value: packet } });
  fireEvent.click(screen.getByRole("button", { name: "Save packet to application" }));
  await waitFor(() => expect(screen.queryByLabelText("Packet and preparation")).toBeNull());
  const saved = p.onSave.mock.calls[0][0];
  expect(saved.fields.notes).toBe("Original source notes");
  expect(saved.fields["interview-packet"]).toBe(packet);
  view.rerender(<NewWorkflows {...p} records={[saved]} />);
  fireEvent.click(screen.getByRole("button", { name: "Prepare interview packet" }));
  expect(screen.getByLabelText("Packet and preparation")).toHaveProperty("value", packet);
});
it("legacy packets in notes reopen all recorded text", () => {
  const original = row("legacy", { title: "Designer", company: "Studio", stage: "Applied", notes: "Original source", resume: "Owned resume" });
  const packet = interviewPacket(original).text + "\n" + "q".repeat(6000) + " final preparation";
  expect(interviewPacket({ ...original, fields: { ...original.fields, notes: packet } }).text).toBe(packet);
});
it("preparing another interview requires explicitly discarding the active draft", () => {
  const p = props("job-search", [row("a", { title: "A", company: "A studio", stage: "Applied" }), row("b", { title: "B", company: "B studio", stage: "Applied" })]);
  render(<NewWorkflows {...p} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Prepare interview packet" })[0]);
  fireEvent.change(screen.getByLabelText("Packet and preparation"), { target: { value: "My unfinished packet" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Prepare interview packet" })[1]);
  expect(screen.getByLabelText("Packet and preparation")).toHaveProperty("value", "My unfinished packet");
  fireEvent.click(screen.getByRole("button", { name: "Discard packet draft" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Prepare interview packet" })[1]);
  expect(screen.getByLabelText("Packet and preparation")).toHaveProperty("value", expect.stringContaining("B studio"));
});
it("all habit check-ins remain editable including old, undated and duplicates across owner groups", () => {
  const date = new Date().toLocaleDateString("en-CA");
  const records = [row("old", { title: "Read", date: "2024-01-01" }), row("undated", { title: "Read" }), row("personal", { title: "Read", date, status: "Done" }), row("work", { title: "Read", date, status: "Skipped" }, "work")];
  const p = { ...props("focus", records), app: { ...props("focus").app, view: "habits" as const } };
  render(<Habits {...p} />);
  const history = screen.getByRole("region", { name: "All saved check-ins" });
  const edits = within(history).getAllByRole("button", { name: /^Edit/ });
  expect(edits).toHaveLength(4);
  edits.forEach(button => fireEvent.click(button));
  expect(p.onEdit.mock.calls.map(([record]) => record.id)).toEqual(records.map(record => record.id));
});
it("long source sentences retain a complete readable question and supported quotation after saving", () => {
  const passage = "Owner notes ".repeat(250) + "endword.";
  const source = row("source", { "source-text": passage });
  const card = sourceQuestions(source)[0];
  const reopened = sourceQuestions(row("card", { "source-text": passage, question: card.question, answer: card.answer, quote: card.quote }))[0];
  expect(reopened.question).toBe(card.question);
  expect(reopened.question).toContain("___");
  expect(reopened.supported).toBe(true);
});
it("oversized generated interview packets keep complete source text and require shortening before saving", () => {
  const notes = "n".repeat(11000) + " final owner note";
  const p = props("job-search", [row("large", { title: "Designer", company: "Studio", stage: "Applied", notes, resume: "r".repeat(6000) })]);
  render(<NewWorkflows {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Prepare interview packet" }));
  expect(screen.getByLabelText("Packet and preparation")).toHaveProperty("value", expect.stringContaining(notes));
  expect((screen.getByLabelText("Packet and preparation") as HTMLTextAreaElement).value.length).toBeGreaterThan(12000);
  fireEvent.click(screen.getByRole("button", { name: "Save packet to application" }));
  expect(p.onSave).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("Your complete draft remains here");
});
