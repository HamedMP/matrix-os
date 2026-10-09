// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { desktopPalette } from "../../packages/brand/src/tokens";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import catalog from "../../home/system/app-gallery.json";
import WorkspaceContent from "../../home/app-templates/connected-starter/src/WorkspaceContent";
import { ImportDialog } from "../../home/app-templates/connected-starter/src/ImportDialog";
import type { Definition } from "../../home/app-templates/connected-starter/src/types";
const subscriptions = catalog.apps.find(app => app.id === "subscriptions") as Definition;
const email = { id: "email_account", service: "gmail", account_label: "Personal", account_email: "reader@example.test", status: "active" };
afterEach(() => { cleanup(); delete window.MatrixOS; });
describe("compact installed app workflows", () => {
  it("gives expanded controls and records nonshrinking rows in short phone windows", () => {
    const css = readFileSync("home/app-templates/connected-starter/src/styles/gallery-light.css", "utf8");
    const compact = css.split("@media (max-width: 700px) and (max-height: 420px)")[1];
    expect(compact).toMatch(/\.workbench\[data-app\]\s*\{[^}]*grid-template-rows:\s*max-content max-content;[^}]*overflow-y:\s*auto/);
    expect(compact).toMatch(/\.sidebar\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible/);
    expect(compact).toMatch(/main\s*\{[^}]*flex:\s*none;[^}]*overflow:\s*visible/);
    const subjects = readFileSync("home/app-templates/connected-starter/src/styles/subject-views.css", "utf8");
    expect(subjects).toMatch(/\.revenue-overview \.balance p[^}]*\{\s*color:\s*var\(--muted\)/);
  });
  it("ships the shared Matrix palette and local fonts inside the installable template", () => {
    const css = readFileSync("home/app-templates/connected-starter/src/styles/brand-tokens.css", "utf8");
    for (const [key, value] of Object.entries(desktopPalette)) expect(css).toContain(`--matrix-brand-${key}: ${value}`);
    for (const name of ["geist-latin-wght-normal.woff2", "bricolage-grotesque-latin-wght-normal.woff2", "geist-OFL.txt", "bricolage-OFL.txt"]) {
      expect(readFileSync(`home/app-templates/connected-starter/public/fonts/${name}`)).toEqual(readFileSync(`home/apps/_shared/fonts/${name}`));
    }
  });
  it("opens an empty subscriptions workspace with a practical heading and working import/manual actions", () => {
    const onImport = vi.fn(), onAdd = vi.fn();
    render(<WorkspaceContent app={subscriptions} records={[]} visible={[]} error="" exportError="" loading={false} limited={false} unavailable="" canUseRecords onEdit={vi.fn()} onEvidence={vi.fn()} onSave={vi.fn()} onAdd={onAdd} onImport={onImport} canImport />);
    expect(screen.getByRole("heading", { name: "All subscriptions", level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No subscriptions yet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Find subscriptions in email" }));
    fireEvent.click(screen.getByRole("button", { name: "Add one manually" }));
    expect(onImport).toHaveBeenCalledOnce();
    expect(onAdd).toHaveBeenCalledOnce();
    expect(screen.queryByText("Everything in view")).toBeNull();
  });
  it("offers email accounts without irrelevant source context and preserves the exact selected identity", async () => {
    const generate = vi.fn();
    window.MatrixOS = { integrations: async () => [email], generate };
    render(<ImportDialog app={subscriptions} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /reader@example.test/ }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask Matrix to import" }));
    expect(generate).toHaveBeenCalledWith(expect.stringContaining('"connectionId":"email_account"'));
    expect(generate).toHaveBeenCalledWith(expect.stringContaining('"sourceContext":""'));
  });
  it("asks for repository scope only after GitHub is selected and validates it before dispatch", async () => {
    const github = { id: "github_account", service: "github", account_label: "Work", status: "active" };
    const app: Definition = { ...subscriptions, services: [{ id: "github", name: "GitHub", actions: ["list_repositories"] }] };
    const generate = vi.fn();
    window.MatrixOS = { integrations: async () => [github], generate };
    render(<ImportDialog app={app} onClose={vi.fn()} />);
    const checkbox = await screen.findByRole("checkbox");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(checkbox);
    const repository = screen.getByRole("textbox", { name: "Repository" });
    fireEvent.click(screen.getByRole("button", { name: "Ask Matrix to import" }));
    expect(generate).not.toHaveBeenCalled();
    fireEvent.change(repository, { target: { value: "matrix-os/core" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask Matrix to import" }));
    expect(generate).toHaveBeenCalledWith(expect.stringContaining('"sourceContext":"matrix-os/core"'));
  });
});
