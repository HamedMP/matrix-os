// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import WorkspaceContent from "../../home/app-templates/connected-starter/src/WorkspaceContent";
import type { Definition } from "../../home/app-templates/connected-starter/src/types";

const catalog = JSON.parse(readFileSync("home/system/app-gallery.json", "utf8")) as { apps: Definition[] };
const subscriptions = catalog.apps.find((app) => app.id === "subscriptions")!;

describe("installed gallery app presentation", () => {
  it("uses the same light styles and artwork in the Gallery screenshots", () => {
    const fixture = readFileSync("specs/362-default-app-sculpted-family/preview/review.tsx", "utf8");
    expect(fixture).toContain('import("../../../home/app-templates/connected-starter/src/styles/gallery-light.css")');
    expect(fixture).toContain('iconDataUrl');
  });
  it("keeps the Subscriptions canvas in the same green family as its icon", () => {
    const identities = JSON.parse(readFileSync("packages/brand/src/app-identities.json", "utf8")) as Record<string, { accent: string }>;
    const css = readFileSync("home/app-templates/connected-starter/src/styles/gallery-light.css", "utf8");
    expect(identities.subscriptions.accent).toBe("#176d56");
    expect(css).toContain("var(--identity-accent, var(--matrix-brand-forest))");
  });
  it("defaults to Matrix paper while allowing the owner theme bridge to supply every surface", () => {
    const main = readFileSync("home/app-templates/connected-starter/src/main.tsx", "utf8");
    const css = readFileSync("home/app-templates/connected-starter/src/styles/gallery-light.css", "utf8");
    expect(main).toContain('import "./styles/gallery-light.css"');
    expect(css).toContain("color-scheme: var(--matrix-color-scheme, light)");
    expect(css).toContain("--bg: var(--matrix-bg, var(--matrix-brand-paper))");
    expect(css).not.toMatch(/--matrix-bg\s*:/);
    expect(css).toContain("--card: var(--matrix-card, var(--matrix-brand-paper))");
    const sidebar = readFileSync("home/app-templates/connected-starter/src/Sidebar.tsx", "utf8");
    expect(sidebar).toContain("app.iconDataUrl");
  });

  it("gives an empty Subscriptions app one useful starting point with an email-import action", () => {
    const onImport = vi.fn();
    render(<WorkspaceContent app={subscriptions} records={[]} visible={[]} error="" exportError="" loading={false}
      limited={false} unavailable="" canUseRecords onEdit={vi.fn()} onEvidence={vi.fn()}
      onAdd={vi.fn()} onSave={vi.fn()} onImport={onImport} canImport />);

    expect(screen.getByRole("heading", { name: "No subscriptions yet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Find subscriptions in email" }));
    expect(onImport).toHaveBeenCalledOnce();
    expect(screen.queryByText("No active subscriptions with a known cost yet.")).toBeNull();
  });
});
