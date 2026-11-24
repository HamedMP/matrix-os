// @vitest-environment jsdom
/**
 * The main Docs journey on the real App with a fake `window.MatrixOS`: open a
 * real contract from the Open dialog, save a copy without edits (parts stay
 * byte-identical), have the assistant propose edits that arrive as tracked
 * revisions, accept and reject them one by one in the Review tab, save, and
 * compare with a second version of the contract into a new tracked-changes
 * document. The fixtures are the engine's real `.docx` files.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDocx, opc } from "../../../home/apps/_shared/office-engine/index";
import { envelope, fixture } from "./agent/helpers";
import { type FakeBridge, fileMenu, findSurface, installBridge, renderApp, titleText } from "./ui/harness";

afterEach(() => {
  cleanup();
  delete (window as unknown as { MatrixOS?: unknown }).MatrixOS;
});

const CONTRACT = "Documents/contract.docx";
const CONTRACT_V2 = "Documents/contract-v2.docx";

interface Journey {
  bridge: FakeBridge;
  prompts: string[];
  serviceCalls: unknown[];
}

/** The bridge with both contract versions, a model that proposes two edits, and a mail service Docs must never call. */
function installJourney(): Journey {
  const bridge = installBridge({ [CONTRACT]: fixture("contract.docx"), [CONTRACT_V2]: fixture("contract-v2.docx") }, { extraPaths: ["Documents/notes.txt"] });
  const prompts: string[] = [];
  const serviceCalls: unknown[] = [];
  const reply = envelope(
    [
      { op: "replaceText", blockId: "b25", find: "24 months", replace: "36 months" },
      { op: "replaceText", blockId: "b26", find: "90 days’", replace: "60 days’" },
    ],
    "Extends the term and shortens the notice period.",
  );
  const matrix = (window as unknown as { MatrixOS: Record<string, unknown> }).MatrixOS;
  matrix.ai = {
    routes: async () => ({ routes: [], defaultRoute: null }),
    generate: async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      return { text: reply };
    },
  };
  matrix.service = async (...args: unknown[]) => {
    serviceCalls.push(args);
    return { messages: [{ id: "18c2f0a1b2", threadId: "18c2f0a1b2" }], resultSizeEstimate: 1 };
  };
  return { bridge, prompts, serviceCalls };
}

async function entries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const parts = new Map<string, Uint8Array>();
  for (const record of opc.parseZip(bytes).records) parts.set(record.name, await opc.readRecord(record));
  return parts;
}

async function pickFromDialog(dialogName: string, folder: string, file: string): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name: dialogName });
  fireEvent.click(await within(dialog).findByRole("button", { name: `Folder ${folder}` }));
  const doc = await within(dialog).findByRole("button", { name: `Document ${file}` });
  // Only folders and Word documents are offered.
  expect(within(dialog).queryByText("notes.txt")).toBeNull();
  fireEvent.click(doc);
  fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: dialogName })).toBeNull());
}

function sidePanel(): HTMLElement {
  return screen.getByRole("complementary", { name: "Review, assistant and compare" });
}

function statusBar(): string {
  return document.querySelector(".docs-status")?.textContent ?? "";
}

describe("Docs app journey", () => {
  it("opens, saves losslessly, reviews assistant edits one by one, saves, and compares two versions", async () => {
    const { bridge, prompts, serviceCalls } = installJourney();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderApp();

    // Start screen: actions and the recent-documents empty state.
    expect(await screen.findByRole("heading", { name: "Recent documents" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No recent documents" })).toBeTruthy();
    expect(screen.getByText("Documents you open appear here.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Browse files…" })).toBeTruthy();

    // Open the contract from the Open dialog.
    fireEvent.click(screen.getByRole("button", { name: /Open from Matrix…/ }));
    await pickFromDialog("Open a document", "Documents", "contract.docx");
    const surface = await findSurface();
    await waitFor(() => expect(titleText()).toBe("contract.docx"));
    expect(surface.textContent).toContain("initial period of 24 months");
    expect(screen.getByTestId("save-state").textContent).toMatch(/Saved/);
    await waitFor(() => expect(bridge.db.rows("recent_documents").map((row) => row.path)).toEqual([CONTRACT]));

    // Acceptance 1: saving without edits keeps every part byte-identical.
    fileMenu("Save a copy");
    await screen.findByText("Saved a copy");
    const copy = bridge.files.bytes("Documents/contract (copy).docx");
    expect(copy).not.toBeNull();
    const original = await entries(fixture("contract.docx"));
    const saved = await entries(copy!);
    expect([...saved.keys()].sort()).toEqual([...original.keys()].sort());
    for (const [name, bytes] of original) expect(saved.get(name), name).toEqual(bytes);
    await waitFor(() => expect(titleText()).toBe("contract (copy).docx"));
    expect(bridge.files.has(CONTRACT)).toBe(true);
    expect(bridge.files.bytes(CONTRACT)).toEqual(fixture("contract.docx"));

    // Acceptance 2: the assistant's edits arrive as tracked revisions.
    fireEvent.click(within(screen.getByRole("tablist", { name: "Document ribbon" })).getByRole("tab", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: "Side panel" }));
    fireEvent.click(await within(sidePanel()).findByRole("tab", { name: /Assistant/ }));
    const ask = await screen.findByLabelText("Ask the agent", {}, { timeout: 5000 });
    fireEvent.change(ask, { target: { value: "Make the term 36 months and the notice 60 days" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    const card = await screen.findByRole("article", { name: "Proposed changes" }, { timeout: 5000 });
    expect(within(card).getByText("2 revisions")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Replaced “24” with “36”" })).toBeTruthy();
    expect(within(card).getByText("Extends the term and shortens the notice period.")).toBeTruthy();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Make the term 36 months and the notice 60 days");
    await waitFor(() => expect(surface.querySelectorAll(".doc-rev-insert").length).toBeGreaterThan(0));
    expect(surface.querySelectorAll(".doc-rev-delete").length).toBeGreaterThan(0);
    expect(surface.textContent).toContain("36");
    await waitFor(() => expect(statusBar()).toMatch(/[1-9]\d* revisions?/));
    expect(screen.getByTestId("save-state").textContent).not.toMatch(/^Saved$/);

    // Review them one by one: accept the term change, reject the notice change.
    fireEvent.click(within(sidePanel()).getByRole("tab", { name: /Review/ }));
    const panel = await screen.findByRole("region", { name: "Tracked changes" });
    fireEvent.click(within(panel).getByRole("button", { name: "Next revision" }));
    // Each edit is a deletion plus an insertion; the current one is accepted or rejected by what it changes.
    const decisions = { accepted: 0, rejected: 0 };
    for (let step = 0; step < 10; step++) {
      const current = within(panel).queryByRole("button", { current: true });
      if (current === null) break;
      // The revised text only: the row also shows the date and time, whose digits must not decide.
      const label = current.querySelector(".docs-review__item-text")?.textContent ?? "";
      if (/36|24/.test(label)) {
        fireEvent.click(within(panel).getByRole("button", { name: "Accept revision" }));
        decisions.accepted++;
      } else if (/60|90/.test(label)) {
        fireEvent.click(within(panel).getByRole("button", { name: "Reject revision" }));
        decisions.rejected++;
      } else break;
      await act(async () => undefined);
    }
    expect(decisions.accepted).toBeGreaterThan(0);
    expect(decisions.rejected).toBeGreaterThan(0);
    await waitFor(() => expect(statusBar()).toMatch(/0 revisions/));
    expect(surface.textContent).toContain("initial period of 36 months");
    expect(surface.textContent).toContain("90 days’ written notice");
    expect(surface.textContent).not.toContain("at least 60 days’ written notice");

    // Save with Ctrl+S: the write carries the version, and the file is a valid, independent document.
    const writesBefore = bridge.files.writes.length;
    fireEvent.keyDown(surface, { key: "s", ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toMatch(/Saved/));
    const write = bridge.files.writes.at(-1)!;
    expect(bridge.files.writes.length).toBe(writesBefore + 1);
    expect(write.path).toBe("Documents/contract (copy).docx");
    expect(write.ifVersion).not.toBeNull();
    const reopened = await openDocx(bridge.files.bytes("Documents/contract (copy).docx")!);
    expect(reopened.listRevisions()).toEqual([]);
    expect(reopened.getPlainText({ view: "final" })).toContain("initial period of 36 months");
    expect(reopened.getPlainText({ view: "final" })).toContain("at least 90 days’ written notice");
    const documentXml = new TextDecoder().decode((await entries(bridge.files.bytes("Documents/contract (copy).docx")!)).get("word/document.xml")!);
    const parsed = new DOMParser().parseFromString(documentXml, "application/xml");
    expect(parsed.getElementsByTagName("parsererror")).toHaveLength(0);

    // Acceptance 3: comparing with the second version opens a document of tracked revisions.
    fireEvent.click(within(sidePanel()).getByRole("tab", { name: /Compare/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose from Files…" }, { timeout: 5000 }));
    await pickFromDialog("Compare with another version", "Documents", "contract-v2.docx");
    const answer = await screen.findByRole("article", { name: "Did anything substantive change?" }, { timeout: 5000 });
    expect(within(answer).getByText("Yes")).toBeTruthy();
    await waitFor(() => expect(titleText()).toContain("compared with contract-v2.docx"));
    const compared = await findSurface();
    await waitFor(() => expect(compared.querySelectorAll(".doc-rev").length).toBeGreaterThan(0));
    expect(statusBar()).toMatch(/[1-9]\d* revisions?/);
    // The comparison is a new, unsaved document; neither version was written.
    expect(bridge.files.bytes(CONTRACT_V2)).toEqual(fixture("contract-v2.docx"));

    // Closing an unsaved comparison asks first (Save, Discard, Cancel), then returns to the start screen with recents.
    fileMenu("Close");
    const confirm = await screen.findByRole("alertdialog", { name: /^Save changes to/ });
    fireEvent.click(within(confirm).getByRole("button", { name: "Discard" }));
    const recent = await screen.findByRole("heading", { name: "Recent documents" });
    const list = recent.parentElement!;
    await waitFor(() => expect(within(list).getByText("contract (copy).docx")).toBeTruthy());
    expect(within(list).getByText("contract.docx")).toBeTruthy();

    // Docs reads and writes files only; it never reaches mail or other services.
    expect(serviceCalls).toEqual([]);
    warn.mockRestore();
  }, 60_000);

  it("opens a file sent by Files with Open with, and explains a corrupt file without writing it", async () => {
    // Built from a Node buffer so the bytes share the engine's Uint8Array realm, as the bridge's bytes do in the app frame.
    const corrupt = new Uint8Array(Buffer.from("PK\u0003\u0004 this is not a complete zip archive"));
    const bridge = installBridge({ [CONTRACT]: fixture("contract.docx"), "Documents/broken.docx": corrupt }, { pending: CONTRACT });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderApp();
    const surface = await findSurface();
    await waitFor(() => expect(titleText()).toBe("contract.docx"));
    expect(surface.textContent).toContain("24 months");

    // A request for a corrupt file while the contract is open keeps the contract and shows why.
    act(() => bridge.sendOpenRequest("Documents/broken.docx"));
    expect(await screen.findByText("The document could not be opened")).toBeTruthy();
    expect(screen.getByText(/not a Word document that Docs can open|damaged and could not be opened/)).toBeTruthy();
    expect(titleText()).toBe("contract.docx");
    expect(bridge.files.writes).toEqual([]);
    expect(bridge.files.bytes("Documents/broken.docx")).toEqual(corrupt);
    warn.mockRestore();
  }, 30_000);
});
