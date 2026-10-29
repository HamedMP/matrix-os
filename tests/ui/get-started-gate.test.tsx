// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productScales } from "@matrix-os/brand/tokens";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { GET_STARTED_WIZARD_STEPS, type GetStartedUpdate, type GetStartedWizardStep, type ProviderSettingsSnapshot, type ProviderWorkflowCapability } from "../../packages/contracts/src/index.js";
import type { ProviderWorkflowClient } from "../../packages/ui/src/agents-providers/types";
import { GetStartedGate, type GetStartedAgentLoginPort, type GetStartedPort } from "../../packages/ui/src/get-started/index.js";

const stepAt = (step: GetStartedWizardStep) => GET_STARTED_WIZARD_STEPS.indexOf(step);

const AT = "2026-10-25T10:12:00.000Z";

function makePort(initial: unknown, overrides: Partial<GetStartedPort> = {}) {
  const saves: GetStartedUpdate[] = [];
  const port: GetStartedPort = {
    load: vi.fn(async () => initial),
    save: vi.fn(async (update: GetStartedUpdate) => {
      saves.push(update);
      if (update.type === "complete") return { status: "completed", completedAt: AT, answers: update.answers };
      if (update.type === "skip") return { status: "skipped", skippedAt: AT };
      return { status: "in_progress", updatedAt: AT, draft: update.draft };
    }),
    ...overrides,
  };
  return { port, saves };
}

function renderGate(port: GetStartedPort) {
  return render(
    <GetStartedGate port={port} zIndex={690}>
      <div data-testid="desktop-widget">widget</div>
    </GetStartedGate>,
  );
}

function renderGateWith(port: GetStartedPort, whileActive: React.ComponentType) {
  return render(
    <GetStartedGate port={port} zIndex={690} whileActive={whileActive}>
      <div data-testid="desktop-widget">widget</div>
    </GetStartedGate>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GetStartedGate", () => {
  it("blocks shortcuts as soon as the setup DOM is committed", async () => {
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    const observed: KeyboardEvent[] = [];
    const observer = new MutationObserver(() => {
      const name = document.querySelector<HTMLInputElement>('input[placeholder="Your first name"]');
      if (!name || observed.length) return;
      for (const [target, modifiers] of [
        [document.body, { metaKey: true }],
        [name, { ctrlKey: true }],
        [name, { altKey: true }],
      ] as const) {
        const event = new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true, ...modifiers });
        observed.push(event);
        target.dispatchEvent(event);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      renderGate(makePort({ status: "pending" }).port);
      await screen.findByPlaceholderText("Your first name");
      expect(observed).toHaveLength(3);
      expect(observed.every((event) => !event.defaultPrevented)).toBe(true);
      expect(shortcut).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
      window.removeEventListener("keydown", shortcut);
    }
  });

  it("restores shortcuts as soon as the setup DOM disappears", async () => {
    renderGate(makePort({ status: "pending" }).port);
    await screen.findByPlaceholderText("Your first name");
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    let restored = false;
    const observer = new MutationObserver(() => {
      if (restored || !screen.queryByTestId("desktop-widget")) return;
      restored = true;
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
      await screen.findByTestId("desktop-widget");
      expect(restored).toBe(true);
      expect(shortcut).toHaveBeenCalledTimes(1);
    } finally {
      observer.disconnect();
      window.removeEventListener("keydown", shortcut);
    }
  });

  it("keeps background shortcuts like the command palette away while setup is open", async () => {
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    try {
      renderGate(makePort({ status: "pending" }).port);
      const name = await screen.findByPlaceholderText("Your first name");
      fireEvent.keyDown(document.body, { key: "k", metaKey: true });
      fireEvent.keyDown(name, { key: "k", ctrlKey: true });
      expect(shortcut).not.toHaveBeenCalled();
      // Plain keys still reach the page, so typing, Tab and Enter keep working.
      fireEvent.keyDown(name, { key: "a" });
      expect(shortcut).toHaveBeenCalledTimes(1);
      // Saving the skip is async; flush the gate's effect cleanup before keys.
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
      });
      expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: "k", metaKey: true });
      expect(shortcut).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("keydown", shortcut);
    }
  });

  it("holds the onboarding widget back while loading, then shows it for computers that are not eligible", async () => {
    let resolve!: (value: unknown) => void;
    const { port } = makePort(null, { load: vi.fn(() => new Promise((done) => { resolve = done; })) });
    renderGate(port);
    expect(screen.queryByTestId("desktop-widget")).not.toBeInTheDocument();
    await act(async () => resolve({ status: "not_eligible" }));
    expect(screen.getByTestId("desktop-widget")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([
    ["the gateway is unreachable", { load: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) }],
    ["the response is malformed", { load: vi.fn(async () => ({ status: "in_progress" })) }],
    ["the wizard is already finished", { load: vi.fn(async () => ({ status: "skipped", skippedAt: AT })) }],
  ])("fails closed to today's desktop when %s", async (_label, overrides) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderGate(makePort(null, overrides).port);
    expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the wizard as a modal with no way to close it, kept out of session replay", async () => {
    renderGate(makePort({ status: "pending" }).port);
    const dialog = await screen.findByRole("dialog", { name: "What should we call you?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.closest(".ph-no-capture")).not.toBeNull();
    // Opaque brand fallback so icons, the dock and windows never show through.
    expect(document.querySelector(".mxo-gs__backdrop")).toHaveStyle({ backgroundColor: productScales.neutral[800] });
    expect(screen.queryByRole("button", { name: /close|minimi[sz]e/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("desktop-widget")).not.toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("walks the questions, saving a draft at each step, and finishes with the answers", async () => {
    const { port, saves } = makePort({ status: "pending" });
    renderGate(port);
    const name = await screen.findByPlaceholderText("Your first name");
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: "Sam" } });
    // Enter that confirms an IME composition (Chinese, Japanese) must not leave the step.
    fireEvent.keyDown(name, { key: "Enter", isComposing: true });
    expect(screen.getByPlaceholderText("Your first name")).toBeInTheDocument();
    fireEvent.keyDown(name, { key: "Enter" });

    expect(await screen.findByRole("dialog", { name: "What will you use Matrix for?" })).toBeInTheDocument();
    await waitFor(() => expect(saves.at(-1)).toEqual({ type: "draft", draft: { step: 1, name: "Sam", goals: [], tools: [] } }));
    fireEvent.click(screen.getByRole("button", { name: "Write code with agents" }));
    expect(screen.getByRole("button", { name: "Write code with agents" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // Spec 636: coding agents sign in on their own screen, before the integrations.
    expect(await screen.findByRole("heading", { name: "Sign in to your coding agents" })).toBeInTheDocument();
    expect(screen.getByText("You can sign in to Claude Code or Codex later in Settings > Agents & providers.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("heading", { name: "Connect the tools you use" })).toBeInTheDocument();
    expect(screen.queryByText("Your coding agent")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Meet your bots" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect(await screen.findByRole("heading", { name: "All set, Sam." })).toBeInTheDocument();
    expect(screen.getByText("Write code with agents")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enter your computer" }));

    expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(saves.at(-1)).toEqual({ type: "complete", answers: { name: "Sam", goals: ["code"], tools: [] } });
  });

  it("lets every question be skipped and goes back without losing answers", async () => {
    renderGate(makePort({ status: "pending" }).port);
    fireEvent.change(await screen.findByPlaceholderText("Your first name"), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    expect(await screen.findByText("Sounds fun")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(await screen.findByPlaceholderText("Your first name")).toHaveValue("Sam");
  });

  it("resumes a saved draft on the step it was left", async () => {
    renderGate(makePort({ status: "in_progress", updatedAt: AT, draft: { step: stepAt("gallery"), name: "Sam", goals: ["build"], tools: [] } }).port);
    expect(await screen.findByRole("button", { name: /Habit tracker/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("fills the name from the sign-in account, and never replaces one the owner typed or saved", async () => {
    const { port } = makePort({ status: "pending" });
    const view = render(<GetStartedGate port={port} zIndex={690} suggestedName={null}><div /></GetStartedGate>);
    const name = await screen.findByPlaceholderText("Your first name");
    expect(name).toHaveValue("");
    // The account loads after the wizard: the field fills once, still editable.
    view.rerender(<GetStartedGate port={port} zIndex={690} suggestedName="Sam Lee"><div /></GetStartedGate>);
    await waitFor(() => expect(name).toHaveValue("Sam"));
    fireEvent.change(name, { target: { value: "" } });
    view.rerender(<GetStartedGate port={port} zIndex={690} suggestedName="Samuel Lee"><div /></GetStartedGate>);
    expect(name).toHaveValue("");
    cleanup();

    render(<GetStartedGate port={makePort({ status: "in_progress", updatedAt: AT, draft: { step: 0, name: "Alex", goals: [], tools: [] } }).port} zIndex={690} suggestedName="Sam Lee"><div /></GetStartedGate>);
    expect(await screen.findByPlaceholderText("Your first name")).toHaveValue("Alex");
  });

  it("never fills a name the owner typed and cleared before the account loaded", async () => {
    const { port } = makePort({ status: "pending" });
    const view = render(<GetStartedGate port={port} zIndex={690} suggestedName={null}><div /></GetStartedGate>);
    const name = await screen.findByPlaceholderText("Your first name");
    fireEvent.change(name, { target: { value: "A" } });
    fireEvent.change(name, { target: { value: "" } });
    view.rerender(<GetStartedGate port={port} zIndex={690} suggestedName="Sam Lee"><div /></GetStartedGate>);
    await act(async () => {});
    expect(name).toHaveValue("");
  });

  it("shows the coding agents screen for every goal, through the surface's sign-in host, and saves a connected agent as a tool", async () => {
    const codexConnected = {
      harnesses: [{ id: "codex", harness: "codex", displayName: "Codex", installState: "installed", authState: "authenticated", connectivity: "online", enabled: true, configuredEnabled: true, accessSourceId: "src_codex", accountIds: ["acct_codex"], selectedAccountId: "acct_codex", loginMethods: ["device_code"] }],
      accounts: [{ id: "acct_codex", accessSourceId: "src_codex", providerId: "openai", authMethod: "subscription", authState: "authenticated", displayName: "sam@example.com" }],
      accessSources: [{ id: "src_codex", kind: "provider_account", providerId: "openai", fundingKind: "owner_subscription", readiness: { state: "ready" }, usage: { kind: "unavailable", reason: "not_reported" } }],
      modelProviders: [], gatewayPolicy: null, configurationHarnessKinds: [], supportedActions: [], access: { mode: "writable" }, refreshedAt: AT,
    } as unknown as ProviderSettingsSnapshot;
    const codex = { harnessInstanceId: "codex", harness: "codex", displayName: "Codex", installState: "installed", loginMethods: ["device_code"], apiKeyProviders: [], install: false, uninstall: false, logs: false } as ProviderWorkflowCapability;
    const agentPort: GetStartedAgentLoginPort = {
      snapshot: codexConnected, failed: false, refresh: vi.fn(), openAuthorizationUrl: vi.fn(),
      workflowClient: { capabilities: vi.fn(async () => [codex]) } as unknown as ProviderWorkflowClient,
    };
    const AgentLogin = ({ children }: { children: (port: GetStartedAgentLoginPort) => React.ReactNode }) => <>{children(agentPort)}</>;
    const { port, saves } = makePort({ status: "in_progress", updatedAt: AT, draft: { step: stepAt("agents"), goals: ["business"], tools: [] } });
    render(<GetStartedGate port={port} zIndex={690} agentLogin={AgentLogin}><div /></GetStartedGate>);
    expect(await screen.findByRole("heading", { name: "Sign in to your coding agents" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Codex/ })).toHaveTextContent("Connected"));
    expect(screen.getByRole("button", { name: /^Claude Code/ })).toBeInTheDocument();
    // OpenCode has no sign-in yet, so the screen does not offer it.
    expect(screen.queryByRole("button", { name: /^OpenCode/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("heading", { name: "Connect the tools you use" })).toBeInTheDocument();
    await waitFor(() => expect(saves.at(-1)).toEqual({ type: "draft", draft: { step: stepAt("tools"), goals: ["business"], tools: ["codex"] } }));
  });

  it("skips the whole setup from the first question", async () => {
    const { port, saves } = makePort({ status: "pending" });
    renderGate(port);
    fireEvent.click(await screen.findByRole("button", { name: "Skip setup" }));
    expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
    expect(saves.at(-1)).toEqual({ type: "skip" });
  });

  it("keeps the answers and offers a retry when finishing fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let fail = true;
    const { port, saves } = makePort({ status: "in_progress", updatedAt: AT, draft: { step: stepAt("summary"), name: "Sam", goals: [], tools: [] } });
    const save = port.save;
    port.save = vi.fn(async (update: GetStartedUpdate) => {
      if (update.type === "complete" && fail) throw new Error("Postgres said no at /home/matrix");
      return save(update);
    });
    renderGate(port);
    fireEvent.click(await screen.findByRole("button", { name: "Enter your computer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't save your setup. Try again.");
    expect(screen.queryByText(/Postgres|\/home/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "All set, Sam." })).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Enter your computer" }));
    expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
    expect(saves.at(-1)).toMatchObject({ type: "complete" });
  });

  it("keeps going when a draft save fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { port } = makePort({ status: "pending" }, { save: vi.fn(async () => { throw new Error("offline"); }) });
    renderGate(port);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByRole("dialog", { name: "What will you use Matrix for?" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("mounts whileActive only while the wizard is open", async () => {
    const events: string[] = [];
    function Lease() {
      React.useEffect(() => {
        events.push("acquire");
        return () => { events.push("release"); };
      }, []);
      return null;
    }
    renderGateWith(makePort({ status: "pending" }).port, Lease);
    await screen.findByRole("dialog");
    await waitFor(() => expect(events).toEqual(["acquire"]));
    // Desktop DOM can commit before passive effects release the native overlay.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    });
    await screen.findByTestId("desktop-widget");
    expect(events).toEqual(["acquire", "release"]);
  });

  it("keeps focus inside when Shift+Tab is pressed from the step heading", async () => {
    renderGate(makePort({ status: "pending" }).port);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    const heading = await screen.findByRole("heading", { name: "What will you use Matrix for?" });
    await waitFor(() => expect(heading).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
  });

  it("does not start queued saves after the wizard is gone", async () => {
    let release!: () => void;
    const { port, saves } = makePort({ status: "pending" });
    const save = port.save;
    port.save = vi.fn(async (update: GetStartedUpdate) => {
      if (saves.length === 0) await new Promise<void>((done) => { release = done; });
      return save(update);
    });
    const view = renderGate(port);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    view.unmount();
    await act(async () => release());
    await new Promise((done) => setTimeout(done, 0));
    expect(port.save).toHaveBeenCalledTimes(1);
  });

  it("leaves the wizard when another window already ended setup", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const states: unknown[] = [{ status: "pending" }, { status: "completed", completedAt: AT, answers: { goals: ["code"], tools: [] } }];
    const port: GetStartedPort = {
      load: vi.fn(async () => states.shift()),
      save: vi.fn(async () => { throw new Error("GetStartedRequestFailed:409"); }),
    };
    renderGate(port);
    fireEvent.click(await screen.findByRole("button", { name: "Skip setup" }));
    expect(await screen.findByTestId("desktop-widget")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(port.load).toHaveBeenCalledTimes(2);
  });

  it("still offers a retry when the save fails and setup is not over", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port: GetStartedPort = {
      load: vi.fn(async () => ({ status: "pending" })),
      save: vi.fn(async () => { throw new Error("GetStartedRequestFailed:500"); }),
    };
    renderGate(port);
    fireEvent.click(await screen.findByRole("button", { name: "Skip setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't save your setup. Try again.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  describe("backdrop", () => {
    function wallpaperSource(image: string) {
      const source = document.createElement("div");
      source.dataset.testWallpaper = "";
      source.style.backgroundImage = image;
      source.style.backgroundColor = "rgb(36, 80, 95)";
      document.body.appendChild(source);
      return source;
    }

    afterEach(() => {
      document.querySelectorAll("[data-test-wallpaper]").forEach((node) => node.remove());
    });

    it("draws the desktop's own wallpaper behind the wizard instead of showing the desktop through", async () => {
      // jsdom drops blob: URLs from CSS, so this uses the web shell's wallpaper URL; Electron's blob URL is copied the same way.
      const url = 'url("https://app.matrix-os.com/api/files/blob?path=system%2Fwallpapers%2Fmatrix-dusk.webp")';
      const source = wallpaperSource(url);
      render(
        <GetStartedGate port={makePort({ status: "pending" }).port} zIndex={690} backdropSource={() => source}>
          <div data-testid="desktop-widget">widget</div>
        </GetStartedGate>,
      );
      await screen.findByRole("dialog");
      const backdrop = document.querySelector(".mxo-gs__backdrop");
      expect(backdrop).not.toBeNull();
      expect(backdrop).toHaveAttribute("aria-hidden", "true");
      await waitFor(() => {
        const image = document.querySelector<HTMLElement>(".mxo-gs__backdrop-image");
        expect(image?.style.backgroundImage).toBe(url);
        expect(image?.style.backgroundColor).toBe("rgb(36, 80, 95)");
      });
    });

    it("follows a wallpaper that loads after the wizard opened", async () => {
      const source = wallpaperSource("none");
      render(
        <GetStartedGate port={makePort({ status: "pending" }).port} zIndex={690} backdropSource={() => source}>
          <div data-testid="desktop-widget">widget</div>
        </GetStartedGate>,
      );
      await screen.findByRole("dialog");
      const url = 'url("https://app.matrix-os.com/api/files/blob?path=system%2Fwallpapers%2Fmatrix-dusk.webp")';
      await act(async () => {
        source.style.backgroundImage = url;
      });
      await waitFor(() => {
        expect(document.querySelector<HTMLElement>(".mxo-gs__backdrop-image")?.style.backgroundImage).toBe(url);
      });
    });

    it("picks up the background layer when it mounts after the wizard (Electron)", async () => {
      render(
        <GetStartedGate
          port={makePort({ status: "pending" }).port}
          zIndex={60}
          backdropSource={() => document.querySelector<HTMLElement>("[data-test-wallpaper]")}
        >
          <div data-testid="desktop-widget">widget</div>
        </GetStartedGate>,
      );
      await screen.findByRole("dialog");
      const url = 'url("https://app.matrix-os.com/api/files/blob?path=system%2Fwallpapers%2Fmatrix-dusk.webp")';
      await act(async () => {
        wallpaperSource(url);
      });
      await waitFor(() => {
        expect(document.querySelector<HTMLElement>(".mxo-gs__backdrop-image")?.style.backgroundImage).toBe(url);
      });
    });

    it("still covers the desktop with the fallback backdrop when no wallpaper is known", async () => {
      renderGate(makePort({ status: "pending" }).port);
      await screen.findByRole("dialog");
      expect(document.querySelector(".mxo-gs__backdrop")).not.toBeNull();
      expect(document.querySelector<HTMLElement>(".mxo-gs__backdrop-image")?.style.backgroundImage ?? "").toBe("");
    });
  });
});

const css = readFileSync("packages/ui/src/get-started/get-started.css", "utf8");
const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[^}]*\\}`))?.[0] ?? "";

describe("get started styles", () => {
  it("covers the whole desktop with an opaque backdrop despite the centered grid", () => {
    expect(rule(".mxo-root.mxo-gs")).toContain("place-items: center");
    const backdrop = rule(".mxo-gs__backdrop");
    expect(backdrop).toContain("inset: 0");
    expect(backdrop).toContain("place-self: stretch");
    expect(backdrop).toContain("width: 100%");
    expect(backdrop).toContain("height: 100%");
    expect(backdrop).toContain("overflow: hidden");
  });

  it("blurs its own copy of the wallpaper instead of relying on backdrop-filter", () => {
    const image = rule(".mxo-gs__backdrop-image");
    expect(image).toMatch(/inset: -\d+px/);
    expect(image).toContain("background-size: cover");
    expect(image).toMatch(/filter: blur\((4[0-9]|[5-9][0-9])px\)/);
    expect(css).not.toContain("backdrop-filter");
  });

  it("keeps a light tint over the blurred wallpaper", () => {
    const scrim = rule(".mxo-gs__scrim");
    expect(scrim).toContain("inset: 0");
    expect(scrim).toContain("place-self: stretch");
    expect(scrim).toContain("color-mix(in srgb, var(--mxo-ink)");
  });
});
