// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { GetStartedUpdate } from "../../packages/contracts/src/index.js";
import { GetStartedGate, type GetStartedConnect, type GetStartedGalleryPort, type GetStartedPort } from "../../packages/ui/src/get-started/index.js";

const AT = "2026-10-23T09:00:00.000Z";

function app(id: string, name: string, services: { id: string; name: string; optional?: boolean }[], installed = false) {
  return { id, name, tagline: `${name} tagline`, icon: id, services, installed };
}

const GALLERY = [
  app("folio", "Folio", [{ id: "gmail", name: "Gmail" }]),
  app("atlas", "Atlas", [{ id: "gmail", name: "Gmail" }, { id: "google_calendar", name: "Google Calendar", optional: true }]),
  app("files", "Files", [{ id: "google_drive", name: "Google Drive" }]),
  app("notes", "Notes", []),
];

function galleryPort(apps = GALLERY): GetStartedGalleryPort & { install: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => ({ version: 1, apps })),
    install: vi.fn(async (id: string) => ({ status: "installed", slug: id, name: id, path: `apps/${id}/index.html` })),
    iconUrl: (id: string) => `https://example.test/icons/gallery-${id}.png`,
  };
}

function connected(services: string[]) {
  return function Connector({ children }: { children: (connect: GetStartedConnect) => React.ReactNode }) {
    return <>{children({
      availableServices: new Set(services), connectedServices: new Set(services), failedServices: new Set(), connectingService: null,
      logoUrls: new Map(), catalog: [], connectionsLoaded: true, unavailable: false, connect: vi.fn(),
    })}</>;
  };
}

function setup(draft: Record<string, unknown> = {}, extra: { gallery?: GetStartedGalleryPort; services?: string[] } = {}) {
  const saves: GetStartedUpdate[] = [];
  const port: GetStartedPort = {
    load: vi.fn(async () => ({ status: "in_progress", updatedAt: AT, draft: { step: 4, name: "Sam", goals: ["code"], tools: [], ...draft } })),
    save: vi.fn(async (update: GetStartedUpdate) => {
      saves.push(update);
      if (update.type === "complete") return { status: "completed", completedAt: AT, answers: update.answers };
      if (update.type === "draft") return { status: "in_progress", updatedAt: AT, draft: update.draft };
      return { status: "skipped", skippedAt: AT };
    }),
  };
  render(
    <GetStartedGate port={port} zIndex={1} gallery={extra.gallery} connector={extra.services ? connected(extra.services) : undefined}>
      <div />
    </GetStartedGate>,
  );
  return { saves };
}

afterEach(() => cleanup());

describe("App Gallery step", () => {
  it("shows what you can build, for every goal", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Build your own apps" })).toBeInTheDocument();
    const ideas = within(screen.getByRole("group", { name: "Build your own apps" })).getAllByRole("button");
    expect(ideas.map((idea) => idea.textContent)).toEqual([
      expect.stringContaining("Habit tracker"),
      expect.stringContaining("Client CRM"),
      expect.stringContaining("Budget planner"),
      expect.stringContaining("Recipe box"),
    ]);
    for (const idea of ideas) expect(idea.querySelector("svg")).not.toBeNull();
  });

  it("keeps the picked idea so Matrix offers to build it on arrival", async () => {
    const { saves } = setup();
    fireEvent.click(await screen.findByRole("button", { name: /Habit tracker/ }));
    expect(screen.getByRole("button", { name: /Habit tracker/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Finish" }));
    fireEvent.click(await screen.findByRole("button", { name: "Enter your computer" }));
    await waitFor(() => expect(saves.at(-1)).toMatchObject({ type: "complete", answers: { appIdea: "habit-tracker" } }));
  });

  it("shows an idea picked on the tools step as already chosen", async () => {
    setup({ goals: ["build"], appIdea: "recipe-box" });
    expect(await screen.findByRole("button", { name: /Recipe box/ })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Apps ready with your data", () => {
  it("lists App Gallery apps that the connected tools make ready, with icons and what they use", async () => {
    const gallery = galleryPort();
    setup({}, { gallery, services: ["gmail", "google_calendar"] });
    expect(await screen.findByRole("heading", { name: "Apps ready with your data" })).toBeInTheDocument();
    expect(screen.getByText("Because you connected Gmail and Google Calendar, these apps are ready with your data.")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Apps ready with your data" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["Atlas", "Folio"]);
    expect(rows[0]!.querySelector("img")).toHaveAttribute("src", "https://example.test/icons/gallery-atlas.png");
    expect(within(rows[0]!).getByText("Uses Gmail and Google Calendar")).toBeInTheDocument();
    // Building your own stays one click away.
    expect(screen.getByText("Or build your own")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Habit tracker/ })).toBeInTheDocument();
  });

  it("adds an app on click and shows it added", async () => {
    const gallery = galleryPort();
    setup({}, { gallery, services: ["gmail"] });
    fireEvent.click(await screen.findByRole("button", { name: "Add Folio" }));
    expect(gallery.install).toHaveBeenCalledWith("folio");
    expect(await screen.findByRole("button", { name: "Folio added" })).toBeDisabled();
  });

  it("keeps the owner on the step while an app is being added, so a failure is never missed", async () => {
    const gallery = galleryPort();
    let finish: (value: unknown) => void = () => undefined;
    gallery.install.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    setup({}, { gallery, services: ["gmail"] });
    fireEvent.click(await screen.findByRole("button", { name: "Add Folio" }));
    for (const name of ["Back", "Skip", "Next"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    finish({ status: "installed", slug: "folio", name: "Folio", path: "apps/folio/index.html" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Skip" })).toBeEnabled();
  });

  it("shows apps already installed as added", async () => {
    setup({}, { gallery: galleryPort([app("folio", "Folio", [{ id: "gmail", name: "Gmail" }], true)]), services: ["gmail"] });
    expect(await screen.findByRole("button", { name: "Folio added" })).toBeDisabled();
  });

  it("falls back to building your own when nothing connected makes an app ready", async () => {
    setup({}, { gallery: galleryPort(), services: ["github"] });
    expect(await screen.findByRole("heading", { name: "Build your own apps" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Apps ready with your data" })).not.toBeInTheDocument();
  });
});
