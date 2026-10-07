// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NewWorkflows from "../../home/app-templates/connected-starter/src/workflows/NewWorkflows";
import type { Definition, OwnerRecord } from "../../home/app-templates/connected-starter/src/types";
import { analyzeCompletedGame } from "../../home/app-templates/connected-starter/src/workflows/chess-engine";

const app = (id: string) => ({ id, name: id, fields: [], collection: "personal", services: [], entity: "record", description: "Your saved records" }) as unknown as Definition;
const row = (id: string, fields: OwnerRecord["fields"]): OwnerRecord => ({ id, fields, scope: "personal", sources: [], accounts: [], manualFields: [], updatedAt: "2026-10-07" });
function props(id: string, records: OwnerRecord[] = []) { return { app: app(id), records, onSave: vi.fn(async (_record: OwnerRecord) => {}), onEdit: vi.fn(), onAdd: vi.fn(), onEvidence: vi.fn() }; }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); delete window.MatrixOS; });
describe("new saved app workflows", () => {
  it("retains a workout draft and stable record ID through a failed save, then reopens its calculated result", async () => {
    const p = props("workout-coach"); p.onSave.mockRejectedValueOnce(new Error("conflict"));
    const view = render(<NewWorkflows {...p} />);
    fireEvent.change(screen.getByLabelText("Exercise"), { target: { value: "Squat" } });
    fireEvent.change(screen.getByLabelText("Load"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Reps"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save set" }));
    await screen.findByRole("alert"); expect((screen.getByLabelText("Exercise") as HTMLInputElement).value).toBe("Squat");
    const first = p.onSave.mock.calls[0][0] as OwnerRecord;
    fireEvent.click(screen.getByRole("button", { name: "Save set" }));
    await waitFor(() => expect(p.onSave).toHaveBeenCalledTimes(2));
    const second = p.onSave.mock.calls[1][0] as OwnerRecord;
    expect(second.id).toBe(first.id); expect(second.fields).toMatchObject({ exercise: "Squat", weight: 50, reps: 5, unit: "kg", "set-type": "Working" });
    view.rerender(<NewWorkflows {...p} records={[second]} />);
    expect(screen.getByText(/250 kg/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit Squat set" })); expect(p.onEdit).toHaveBeenCalledWith(second);
  });
  it("keeps study answers concealed until retrieval and saves reviewed recall against the source card", async () => {
    const record = row("card", { title: "Biology", "source-text": "Mitochondria produce ATP.", question: "What produces ATP?", answer: "Mitochondria", quote: "Mitochondria produce ATP.", practice: "New" });
    const p = props("study-notes", [record]); render(<NewWorkflows {...p} />);
    expect(screen.queryByText("Mitochondria")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal answer" })); expect(screen.getByText("Mitochondria")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I recalled it" }));
    await waitFor(() => expect(p.onSave).toHaveBeenCalled());
    expect((p.onSave.mock.calls[0][0] as OwnerRecord).fields.practice).toBe("Recalled");
  });
  it("requests journal synthesis only on an explicit action and excludes unselected private text", async () => {
    window.MatrixOS = { generate: vi.fn() };
    const p = props("journal-memory", [row("yes", { title: "Walk", date: "2026-10-05", entry: "Walked with Ada", include: "Include", kind: "Entry" }), row("no", { title: "Private", date: "2026-10-05", entry: "Excluded private sentence", include: "Exclude", kind: "Entry" })]);
    render(<NewWorkflows {...p} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Through"), { target: { value: "2026-10-07" } });
    expect(window.MatrixOS.generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Request a source-grounded reflection" }));
    expect(window.MatrixOS.generate).toHaveBeenCalledTimes(1);
    const prompt = (window.MatrixOS.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(prompt).toContain("Walked with Ada"); expect(prompt).not.toContain("Excluded private sentence");
    expect(screen.getByRole("status").textContent).toContain("requested");
  });
  it.each(["paycheck-runway", "meal-planner", "job-search", "chess-coach"])("%s exposes an honest manual input path", id => {
    const p = props(id); render(<NewWorkflows {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /Add (cash or commitment|meal|application|completed game)/i }));
    expect(p.onAdd).toHaveBeenCalledTimes(1);
  });
  it("blocks a prepared digest if its included entry was excluded before saving", () => {
    const record = row("yes", { title: "Walk", date: "2026-10-05", entry: "Private walk", include: "Include" });
    const p = props("journal-memory", [record]), view = render(<NewWorkflows {...p} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Through"), { target: { value: "2026-10-07" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare a cited entry digest" }));
    view.rerender(<NewWorkflows {...p} records={[{ ...record, fields: { ...record.fields, include: "Exclude" } }]} />);
    expect((screen.getByRole("button", { name: "Save reviewed digest" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("changed");
    expect(p.onSave).not.toHaveBeenCalled();
  });
  it("reports an invalid journal period instead of silently presenting an empty selection", () => {
    render(<NewWorkflows {...props("journal-memory")} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-08" } });
    fireEvent.change(screen.getByLabelText("Through"), { target: { value: "2026-10-01" } });
    expect(screen.getByRole("alert").textContent).toContain("valid period");
  });
  it("keeps a Work-only journal digest in Work ownership", async () => {
    const record = { ...row("work", { title: "Meeting", date: "2026-10-05", entry: "Work passage" }), scope: "work" as const }, p = props("journal-memory", [record]);
    render(<NewWorkflows {...p} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Through"), { target: { value: "2026-10-07" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare a cited entry digest" }));
    fireEvent.click(screen.getByRole("button", { name: "Save reviewed digest" }));
    await waitFor(() => expect(p.onSave).toHaveBeenCalled()); expect(p.onSave.mock.calls[0][0].scope).toBe("work");
  });
  it("exposes saved meals with missing status for correction", () => {
    const record = row("unknown", { title: "Unclassified soup", servings: 2, ingredients: "water | 1 | l" }), p = props("meal-planner", [record]);
    render(<NewWorkflows {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Unclassified soup" })); expect(p.onEdit).toHaveBeenCalledWith(record);
  });
  it("resumes only unsaved study cards after a partial failure and reuses the pending card ID", async () => {
    const p = props("study-notes"); p.onSave.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("failure"));
    render(<NewWorkflows {...p} />);
    fireEvent.change(screen.getByLabelText("Your source passage"), { target: { value: "Mitochondria produce ATP. Chloroplasts perform photosynthesis." } });
    fireEvent.click(screen.getByRole("button", { name: "Create and save practice cards" }));
    await screen.findByRole("alert");
    const pending = p.onSave.mock.calls[1][0];
    fireEvent.click(screen.getByRole("button", { name: /Retry remaining cards/ }));
    await waitFor(() => expect(p.onSave).toHaveBeenCalledTimes(3));
    expect(p.onSave.mock.calls[2][0].id).toBe(pending.id);
  });
  it("reviews a real meal rotation before saving and resumes only its remaining meals", async () => {
    const recipe = row("recipe", { title: "Rice", status: "Recipe", servings: 2, ingredients: "rice | 200 | g", pantry: "rice | 50 | g" });
    const p = props("meal-planner", [recipe]); p.onSave.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("failure"));
    const view = render(<NewWorkflows {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview seven-day rotation" })); expect(p.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save this rotation" })); await screen.findByRole("alert");
    const pending = p.onSave.mock.calls[1][0];
    fireEvent.click(screen.getByRole("button", { name: "Retry remaining meals" })); await waitFor(() => expect(p.onSave).toHaveBeenCalledTimes(8));
    expect(p.onSave.mock.calls[2][0].id).toBe(pending.id);
    const records = Array.from(new Map(p.onSave.mock.calls.map(([record]) => [record.id, record])).values());
    expect(records).toHaveLength(7); expect(records.every(record => record.fields.pantry === null)).toBe(true);
    view.rerender(<NewWorkflows {...p} records={[recipe, ...records]} />);
    expect(screen.getByText("1400 g")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit Rice" })[0]); expect(p.onEdit).toHaveBeenCalled();
  });
  it("preserves a prepared interview draft when a newer application arrives", () => {
    const original = row("role", { title: "Designer", company: "Example studio", stage: "Interview", notes: "Original notes" });
    const p = props("job-search", [original]), view = render(<NewWorkflows {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare interview packet" }));
    fireEvent.change(screen.getByLabelText("Packet and preparation"), { target: { value: "My unsaved preparation" } });
    const newer = { ...original, fields: { ...original.fields, notes: "Newer saved notes" }, updatedAt: "2026-10-08" };
    view.rerender(<NewWorkflows {...p} records={[newer]} />);
    expect((screen.getByLabelText("Packet and preparation") as HTMLTextAreaElement).value).toBe("My unsaved preparation");
    expect((screen.getByRole("button", { name: "Save packet to application" }) as HTMLButtonElement).disabled).toBe(true);
    expect(p.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft and prepare from saved application" }));
    expect((screen.getByRole("button", { name: "Save packet to application" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("uses only the selected seven days for meals and groceries while retaining old plans", () => {
    const old = Array.from({ length: 31 }, (_, i) => row(`old-${i}`, { title: `Old meal ${i}`, date: "2026-09-01", status: "Planned", servings: 1, "planned-portions": 1, ingredients: "rice | 10 | g" }));
    const current = row("current", { title: "Current soup", date: "2026-10-08", status: "Planned", servings: 1, "planned-portions": 2, ingredients: "water | 250 | ml" });
    const later = row("later", { title: "Later meal", date: "2026-10-14", status: "Planned", servings: 1, "planned-portions": 1, ingredients: "pasta | 100 | g" });
    const p = props("meal-planner", [...old, current, later]); render(<NewWorkflows {...p} />);
    fireEvent.change(screen.getByLabelText("Week starts"), { target: { value: "2026-10-07" } });
    expect(screen.getByText("500 ml")).toBeTruthy(); expect(screen.queryByText("310 g")).toBeNull(); expect(screen.queryByText("100 g")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit Current soup" })).toBeTruthy();
    expect(screen.getByText("Other saved meal plans (32)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Week starts"), { target: { value: "2026-10-14" } });
    expect(screen.getByText("100 g")).toBeTruthy(); expect(screen.queryByText("500 ml")).toBeNull();
  });
  it.each(["workout-coach", "journal-memory", "study-notes"])("%s saves explicit Work inline input as Work", async id => {
    const p = { ...props(id), creationScope: "work" as const }; render(<NewWorkflows {...p} />);
    expect((screen.getByLabelText("Save new records in") as HTMLSelectElement).value).toBe("work");
    if (id === "workout-coach") {
      fireEvent.change(screen.getByLabelText("Exercise"), { target: { value: "Squat" } }); fireEvent.change(screen.getByLabelText("Load"), { target: { value: "20" } }); fireEvent.change(screen.getByLabelText("Reps"), { target: { value: "5" } }); fireEvent.click(screen.getByRole("button", { name: "Save set" }));
    } else if (id === "journal-memory") {
      fireEvent.change(screen.getByLabelText("Today’s words"), { target: { value: "Work planning notes" } }); fireEvent.click(screen.getByRole("button", { name: "Save entry" }));
    } else {
      fireEvent.change(screen.getByLabelText("Your source passage"), { target: { value: "Work research requires confirmed evidence." } }); fireEvent.click(screen.getByRole("button", { name: "Create and save practice cards" }));
    }
    await waitFor(() => expect(p.onSave).toHaveBeenCalled()); expect(p.onSave.mock.calls.every(([record]) => record.scope === "work")).toBe(true);
  });
  it("invalidates a digest when an unchanged source moves to Work ownership", () => {
    const record = row("scope-source", { title: "Planning", date: "2026-10-05", entry: "Original planning passage", include: "Include" });
    const p = props("journal-memory", [record]), view = render(<NewWorkflows {...p} />);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } }); fireEvent.change(screen.getByLabelText("Through"), { target: { value: "2026-10-07" } }); fireEvent.click(screen.getByRole("button", { name: "Prepare a cited entry digest" }));
    view.rerender(<NewWorkflows {...p} records={[{ ...record, scope: "work" }]} />);
    expect((screen.getByRole("button", { name: "Save reviewed digest" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Prepare a cited entry digest" })); expect((screen.getByRole("button", { name: "Save reviewed digest" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("does not prepare a second packet while the first save is unresolved", async () => {
    const p = props("job-search", [row("a", { title: "A", company: "A studio", stage: "Applied" }), row("b", { title: "B", company: "B studio", stage: "Applied" })]);
    let resolveSave!: () => void; p.onSave.mockImplementation(() => new Promise<void>(resolve => { resolveSave = resolve; }));
    render(<NewWorkflows {...p} />); fireEvent.click(screen.getAllByRole("button", { name: "Prepare interview packet" })[0]); fireEvent.click(screen.getByRole("button", { name: "Save packet to application" }));
    expect(screen.getAllByRole("button", { name: "Prepare interview packet" }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
    await act(async () => resolveSave()); fireEvent.click(screen.getAllByRole("button", { name: "Prepare interview packet" })[1]); expect(screen.getByText("B studio interview packet")).toBeTruthy();
  });
  it("terminates chess workers on cancel, source edits and unmount", () => {
    const workers: FakeWorker[] = [];
    class FakeWorker { onmessage: ((event: { data: unknown }) => void) | null = null; onerror = null; terminate = vi.fn(); postMessage = vi.fn(); constructor() { workers.push(this); } }
    vi.stubGlobal("Worker", FakeWorker);
    const record = row("game", { title: "Finished", status: "Completed", pgn: '1. e4 e5 1-0', perspective: "White" }), p = props("chess-coach", [record]);
    const view = render(<NewWorkflows {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze completed game" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel search" })); expect(workers[0].terminate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Analyze completed game" }));
    view.rerender(<NewWorkflows {...p} records={[{ ...record, fields: { ...record.fields, pgn: '1. d4 d5 1-0' } }]} />);
    expect(workers[1].terminate).toHaveBeenCalledOnce();
    workers[1].onmessage?.({ data: { ok: false } }); expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Analyze completed game" })); view.unmount(); expect(workers[2].terminate).toHaveBeenCalledOnce();
  });
  it("terminates a chess search at its eight-second runtime cap", () => {
    vi.useFakeTimers(); const terminate = vi.fn();
    vi.stubGlobal("Worker", class { onmessage = null; onerror = null; postMessage = vi.fn(); terminate = terminate; });
    render(<NewWorkflows {...props("chess-coach", [row("game", { status: "Completed", pgn: '1. e4 e5 1-0' })])} />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze completed game" }));
    act(() => vi.advanceTimersByTime(8000));
    expect(terminate).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert").textContent).toContain("time limit");
  });
  it("saves only a validated chess review and invalidates it when the underlying PGN changes", async () => {
    let worker: { onmessage: ((event: { data: unknown }) => void) | null };
    vi.stubGlobal("Worker", class { onmessage = null; onerror = null; postMessage = vi.fn(); terminate = vi.fn(); constructor() { worker = this; } });
    const pgn = '1. e4 e5 1-0', record = row("game", { title: "Finished", status: "Completed", pgn, perspective: "White" }), p = props("chess-coach", [record]);
    const view = render(<NewWorkflows {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Analyze completed game" }));
    act(() => worker!.onmessage?.({ data: { ok: true, analysis: analyzeCompletedGame(pgn, "Completed", { maxDepth: 1, maxNodes: 500, timeoutMs: 1000, positions: 1 }) } }));
    fireEvent.click(screen.getByRole("button", { name: "Save this local review" })); await waitFor(() => expect(p.onSave).toHaveBeenCalledOnce());
    const saved = p.onSave.mock.calls[0][0]; expect(saved.fields.analysis).toContain("sourceSignature");
    view.unmount(); const reopened = render(<NewWorkflows {...p} records={[saved]} />); expect(screen.getByRole("button", { name: "Reveal local search" })).toBeTruthy();
    reopened.rerender(<NewWorkflows {...p} records={[{ ...saved, fields: { ...saved.fields, pgn: '1. d4 d5 1-0' } }]} />);
    expect(screen.queryByRole("button", { name: "Reveal local search" })).toBeNull();
  });
});
