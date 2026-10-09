// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { importPrompt } from "../../home/app-templates/connected-starter/src/import";
import { ImportDialog } from "../../home/app-templates/connected-starter/src/ImportDialog";
import { parseGalleryInventory } from "../../packages/contracts/src/app-gallery-inventory";
import catalog from "../../home/system/app-gallery.json";
import type { Definition } from "../../home/app-templates/connected-starter/src/types";
const app = catalog.apps.find(a => a.id === "follow-ups") as Definition;
const connection = { id: "selected_connection", service: "gmail", account_label: "Personal", account_email: "selected@example.test", status: "active" };
const selection = { accounts: [{ service: "gmail", label: "Personal", connectionId: "selected_connection", expectedEmail: "selected@example.test" }], start: "2026-01-01", end: "2026-10-06", context: "" };
afterEach(() => { cleanup(); delete window.MatrixOS; });
describe("gallery import connection binding", () => {
  it("retains bounded immutable IDs in the canonical inventory", () => {
    expect(parseGalleryInventory([connection])[0]).toEqual(connection);
    expect(() => parseGalleryInventory([{ ...connection, id: "x".repeat(257) }])).toThrow();
  });
  it("includes the exact snapshot and requires binding on every read", () => {
    const prompt = importPrompt(app, selection, [connection]);
    expect(prompt).toContain('"connectionId":"selected_connection"');
    expect(prompt).toContain('"expectedEmail":"selected@example.test"');
    expect(prompt).toContain("/api/integrations/read-call");
    expect(prompt).toContain("accountBinding");
    expect(prompt).toContain("galleryImport:true");
    expect(prompt).toContain("every read");
  });
  it.each([{ ...connection, id: "replacement_connection" }, { ...connection, account_email: "replacement@example.test" }])("fails closed when inventory changed %j", changed => {
    expect(() => importPrompt(app, selection, [changed])).toThrow(/Choose/);
  });
  it("requires an immutable selection before dispatch", () => {
    // @ts-expect-error Test the runtime boundary for older or forged bridge callers.
    expect(() => importPrompt(app, { ...selection, accounts: [{ service: "gmail", label: "Personal" }] }, [connection])).toThrow(/Choose/);
  });
  it("preserves an explicit null snapshot when the connection has no email", () => {
    const prompt = importPrompt(app, { ...selection, accounts: [{ ...selection.accounts[0], expectedEmail: null }] }, [{ ...connection, account_email: null }]);
    expect(prompt).toContain('"expectedEmail":null');
  });
  it("captures selected identity in the actual dialog dispatch", async () => {
    const generate = vi.fn();
    window.MatrixOS = { integrations: async () => [connection], generate };
    render(createElement(ImportDialog, { app, onClose: () => {} }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Ask Matrix to import" }));
    expect(generate).toHaveBeenCalledWith(expect.stringContaining('"connectionId":"selected_connection"'));
  });
  it("disables imports from inventories that cannot identify the connection", async () => {
    const { id: _id, ...legacy } = connection;
    window.MatrixOS = { integrations: async () => [legacy], generate: vi.fn() };
    render(createElement(ImportDialog, { app, onClose: () => {} }));
    expect((await screen.findByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });
});
