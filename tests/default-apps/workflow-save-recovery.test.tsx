// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import catalog from "../../home/system/app-gallery.json";
import ExistingWorkflows from "../../home/app-templates/connected-starter/src/ExistingWorkflows";
import { Study } from "../../home/app-templates/connected-starter/src/workflows/ApplicationsStudyJournal";
import Focus from "../../home/app-templates/connected-starter/src/views/Focus";
import { RecordConflictError } from "../../home/app-templates/connected-starter/src/persistence";
import { parseIngredients, mealGroceries } from "../../home/app-templates/connected-starter/src/workflows/models";
import type { Definition, OwnerRecord } from "../../home/app-templates/connected-starter/src/types";
const row = (id: string, fields: OwnerRecord["fields"]): OwnerRecord => ({ id, fields, scope: "personal", sources: [], accounts: [], manualFields: [], updatedAt: "2026-10-09" });
const props = (id: string, records: OwnerRecord[] = []) => ({ app: catalog.apps.find(app => app.id === id) as Definition, records, onSave: vi.fn(async (_record: OwnerRecord) => {}), onEdit: vi.fn(), onEvidence: vi.fn(), onAdd: vi.fn() });
beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it.each([
  ["atlas", "Preparation note for Journey", "Save preparation", "preparation"],
  ["meeting-briefs", "Actions for Journey", "Save actions", "actions"],
])("%s explains a save conflict while keeping the draft and original record base until explicit discard", async (id, label, button, field) => {
  const original = row("original", { title: "Journey", [field]: "Saved text" });
  const p = props(id, [original]); p.onSave.mockRejectedValue(new RecordConflictError());
  const view = render(<ExistingWorkflows {...p} />);
  fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value: "Unsaved owner text" } });
  fireEvent.click(screen.getByRole("button", { name: button }));
  expect((await screen.findByRole("alert")).textContent).toContain("This record changed since you opened it");
  expect(screen.getByRole("alert").textContent).toContain("review the latest version before saving");
  const newer = { ...original, fields: { ...original.fields, [field]: "Latest saved text" }, updatedAt: "2026-10-10" };
  view.rerender(<ExistingWorkflows {...p} records={[newer]} />);
  expect(screen.getByRole("textbox", { name: label })).toHaveProperty("value", "Unsaved owner text");
  expect(p.onSave.mock.calls[0][0]).toMatchObject({ updatedAt: original.updatedAt, fields: { [field]: "Unsaved owner text" } });
  fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload saved text" }));
  expect(screen.getByRole("textbox", { name: label })).toHaveProperty("value", "Latest saved text");
  expect(screen.queryByRole("alert")).toBeNull();
});
it("Study stops remaining failed saves explicitly, preserves saved cards, and accepts a new passage", async () => {
  const p = props("study-notes"); p.onSave.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Save failure"));
  const view = render(<Study {...p} />);
  const passage = "Cells contain genetic information. Membranes control what enters cells. Proteins perform cellular functions.";
  fireEvent.change(screen.getByLabelText("Passage title"), { target: { value: "Biology" } });
  fireEvent.change(screen.getByLabelText("Your source passage"), { target: { value: passage } });
  fireEvent.click(screen.getByRole("button", { name: "Create and save practice cards" }));
  await screen.findByRole("alert");
  const savedCard = p.onSave.mock.calls[0][0], failedCard = p.onSave.mock.calls[1][0];
  view.rerender(<Study {...p} records={[savedCard]} />);
  expect(screen.getByLabelText("Your source passage")).toHaveProperty("value", passage);
  expect(screen.getByLabelText("Your source passage")).toHaveProperty("disabled", true);
  expect(screen.getByText(/Stopping keeps your saved cards/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop remaining saves" }));
  expect(screen.getByLabelText("Your source passage")).toHaveProperty("disabled", false);
  expect(screen.getByLabelText("Passage title")).toHaveProperty("disabled", false);
  expect(screen.getByLabelText("Your source passage")).toHaveProperty("value", passage);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: `Edit ${savedCard.fields.title}` })).toBeTruthy();
  expect(p.onSave).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText("Your source passage"), { target: { value: "Gravity attracts objects with mass." } });
  fireEvent.change(screen.getByLabelText("Passage title"), { target: { value: "Physics" } });
  fireEvent.click(screen.getByRole("button", { name: "Create and save practice cards" }));
  await waitFor(() => expect(p.onSave).toHaveBeenCalledTimes(3));
  expect(p.onSave.mock.calls[2][0]).toMatchObject({ fields: { "source-text": "Gravity attracts objects with mass." } });
  expect(p.onSave.mock.calls[2][0].id).not.toBe(savedCard.id);
  expect(p.onSave.mock.calls[2][0].id).not.toBe(failedCard.id);
});
it("Study keeps a first-card failure until explicit discard and disables discard during a pending save", async () => {
  const p = props("study-notes"); let rejectSave!: (error: Error) => void;
  p.onSave.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSave = reject; }));
  render(<Study {...p} />);
  fireEvent.change(screen.getByLabelText("Your source passage"), { target: { value: "Gravity attracts objects with mass." } });
  fireEvent.click(screen.getByRole("button", { name: "Create and save practice cards" }));
  const discard = screen.getByRole("button", { name: "Discard card drafts" });
  expect(discard).toHaveProperty("disabled", true);
  fireEvent.click(discard);
  expect(screen.getByLabelText("Your source passage")).toHaveProperty("disabled", true);
  await act(async () => rejectSave(new Error("failure")));
  expect(screen.getByRole("button", { name: "Discard card drafts" })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "Discard card drafts" }));
  expect(screen.getByLabelText("Your source passage")).toHaveProperty("disabled", false);
  expect(screen.getByLabelText("Your source passage")).toHaveProperty("value", "Gravity attracts objects with mass.");
});
it.each([new RecordConflictError(), { privateDetail: "do not log this object" }])("Focus classifies save failures and retains the completed session for recovery", async failure => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const p = props("focus"); p.onSave.mockRejectedValueOnce(failure);
  render(<Focus {...p} />);
  fireEvent.change(screen.getByLabelText("Focus task"), { target: { value: "Research" } });
  fireEvent.click(screen.getByRole("button", { name: "Begin focus" }));
  act(() => vi.advanceTimersByTime(25 * 60 * 1000));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Log completed session" })));
  expect(console.error).toHaveBeenCalledWith("Focus session save failed", failure instanceof Error ? failure.name : "UnknownError");
  expect(screen.getByLabelText("Focus task")).toHaveProperty("value", "Research");
  expect(screen.getByRole("alert").textContent).toContain(failure instanceof RecordConflictError ? "This record changed since you opened it" : "Session could not be saved");
  const failedId = p.onSave.mock.calls[0][0].id;
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Log completed session" })));
  expect(p.onSave.mock.calls[1][0].id).toBe(failedId);
  expect(screen.getByLabelText("Focus task")).toHaveProperty("value", "");
});
it.each(["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "cups"])("unknown ingredient unit %s cannot resolve inherited conversion properties", unit => {
  const parsed = parseIngredients(`rice | 2 | ${unit}`);
  const normalized = unit.toLowerCase();
  if (/^[a-z ]{1,24}$/.test(normalized)) expect(parsed).toEqual({ ingredients: [{ name: "rice", quantity: 2, unit: normalized }], issues: [] });
  else expect(parsed.ingredients).toEqual([]);
  expect(mealGroceries([row("meal", { title: "Rice", status: "Planned", date: "2026-10-09", servings: 1, "planned-portions": 2, ingredients: `rice | 2 | ${unit}` })]).items).toEqual(parsed.ingredients.map(item => ({ ...item, quantity: item.quantity * 2 })));
});
it.each([false, true])("Study preserves an unrelated typed passage after saved-source cards complete (retry: %s)", async retry => {
  const savedPassage = "Cells contain genetic information. Membranes control what enters cells. Proteins perform cellular functions.";
  const typedPassage = "Gravity attracts objects with mass.";
  const p = props("study-notes", [row("saved-source", { title: "Biology", "source-text": savedPassage })]);
  if (retry) p.onSave.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Save failure"));
  render(<Study {...p} />);
  fireEvent.change(screen.getByLabelText("Passage title"), { target: { value: "Unsaved physics" } });
  fireEvent.change(screen.getByLabelText("Your source passage"), { target: { value: typedPassage } });
  fireEvent.click(screen.getByRole("button", { name: "Create practice cards" }));
  if (retry) {
    await screen.findByRole("alert");
    const failedId = p.onSave.mock.calls[1][0].id; fireEvent.click(screen.getByRole("button", { name: /Retry remaining cards/ }));
    await waitFor(() => expect(p.onSave).toHaveBeenCalledTimes(4));
    expect(p.onSave.mock.calls[2][0].id).toBe(failedId);
  }
  await waitFor(() => expect(screen.getByLabelText("Your source passage")).toHaveProperty("disabled", false));
  expect(screen.getByLabelText("Passage title")).toHaveProperty("value", "Unsaved physics");
  expect(screen.getByLabelText("Your source passage")).toHaveProperty("value", typedPassage);
  expect(p.onSave.mock.calls.every(([card]) => card.fields["source-text"] === savedPassage)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Create and save practice cards" }));
  await waitFor(() => expect(screen.getByLabelText("Your source passage")).toHaveProperty("value", ""));
  expect(screen.getByLabelText("Passage title")).toHaveProperty("value", "");
  expect(p.onSave.mock.calls.at(-1)?.[0].fields["source-text"]).toBe(typedPassage);
});
