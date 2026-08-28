// @vitest-environment jsdom

// Component tests for the desktop integrations settings section. The section
// mirrors the shell IntegrationsSection data flow against the gateway proxy
// routes /api/integrations* but stays renderer-only: OAuth consent opens via
// the HTTPS-only shell:open-external bridge and status polls go through the
// typed ApiClient (bearer injected by the trusted core at the network layer).
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntegrationsSettingsSection,
  useIntegrations,
} from "../../desktop/src/renderer/src/features/integrations";
import { AppError } from "../../desktop/src/shared/app-error";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { advanceRuntimeGeneration } from "../../desktop/src/renderer/src/stores/runtime-generation";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";

const CONN_ID = "7d3f6f1e-2b3c-4a5d-8e9f-0a1b2c3d4e5f";
const NEW_CONN_ID = "8e4a7a2f-3c4d-5b6e-9f0a-1b2c3d4e5f60";

const AVAILABLE = [
  { id: "gmail", name: "Gmail", category: "google", icon: "mail", logoUrl: "https://cdn.test/gmail.png", actions: {} },
  { id: "github", name: "GitHub", category: "developer", icon: "code", logoUrl: "https://cdn.test/github.png", actions: {} },
];

const GMAIL_CONNECTION = {
  id: CONN_ID,
  service: "gmail",
  account_label: "Work",
  account_email: "work@example.com",
  scopes: [],
  status: "active",
  connected_at: "2026-06-01T00:00:00.000Z",
  last_used_at: null,
};

const NEW_GMAIL_CONNECTION = {
  ...GMAIL_CONNECTION,
  id: NEW_CONN_ID,
  account_label: "Personal",
  account_email: "personal@example.com",
};

interface FakeApiOptions {
  available?: unknown;
  connections?: unknown;
  syncServices?: unknown;
  connectUrl?: string;
  getError?: (path: string) => Error | null;
  deleteError?: Error;
}

function makeApi(opts: FakeApiOptions = {}) {
  const {
    available = AVAILABLE,
    connections = [GMAIL_CONNECTION],
    syncServices = [GMAIL_CONNECTION],
    connectUrl = "https://pipedream.com/connect?token=abc",
    getError,
    deleteError,
  } = opts;
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      const err = getError?.(path);
      if (err) throw err;
      if (path === "/api/integrations/available") return available;
      if (path === "/api/integrations") return connections;
      throw new AppError("notFound");
    }),
    post: vi.fn(async (path: string) => {
      if (path === "/api/integrations/connect") return { url: connectUrl, service: "gmail" };
      if (path === "/api/integrations/sync") return { synced: 1, services: syncServices };
      throw new AppError("notFound");
    }),
    delete: vi.fn(async () => {
      if (deleteError) throw deleteError;
      return { ok: true };
    }),
    patch: vi.fn(),
    put: vi.fn(),
    putText: vi.fn(),
    getText: vi.fn(),
    getBlob: vi.fn(),
  } as unknown as ApiClient;
}

describe("desktop integrations settings section", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    window.operator = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(() => () => undefined),
    };
    useIntegrations.setState(useIntegrations.getInitialState(), true);
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      api: makeApi() as never,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders a loading skeleton while the proxy responds", () => {
    const pending = new Promise<unknown>(() => undefined);
    useConnection.setState({
      api: {
        ...makeApi(),
        get: vi.fn(async () => pending),
      } as never,
    });
    render(<IntegrationsSettingsSection />);
    expect(screen.getByTestId("integrations-loading")).not.toBeNull();
  });

  it("lists available services with their Pipedream logo and an initial fallback", async () => {
    const { container } = render(<IntegrationsSettingsSection />);
    await waitFor(() => expect(screen.getByText("Gmail")).not.toBeNull());

    expect(screen.getByText("GitHub")).not.toBeNull();
    expect(screen.getByText("google")).not.toBeNull();
    expect(screen.getByTestId("integration-icon-gmail").getAttribute("src"))
      .toBe("https://cdn.test/gmail.png");
    expect(screen.getByTestId("integration-icon-gmail").className).not.toContain("rounded");
    expect(screen.getByTestId("integration-icon-gmail").className).toContain("object-fill");
    expect(screen.getByTestId("integration-icon-gmail-container").className).toContain("rounded");
    expect(screen.getByTestId("integration-icon-github").getAttribute("src"))
      .toBe("https://cdn.test/github.png");
  });

  it("renders the Figma-style unified integration grid", async () => {
    const api = makeApi({
      available: [
        { id: "github", name: "GitHub", category: "developer", logoUrl: "https://cdn.test/github.png", actions: {} },
        { id: "slack", name: "Slack", category: "communication", logoUrl: "https://cdn.test/slack.png", actions: {} },
        { id: "linear", name: "Linear", category: "project_management", logoUrl: "https://cdn.test/linear.png", actions: {} },
      ],
      connections: [{ ...GMAIL_CONNECTION, service: "slack", account_label: "Slack" }],
    });
    useConnection.setState({ api: api as never });
    render(<IntegrationsSettingsSection />);

    await waitFor(() => expect(screen.getByTestId("integrations-grid")).not.toBeNull());

    expect(screen.getByTestId("settings-section-header-title").className).toContain("text-lg");
    expect(screen.getByTestId("settings-section-header-title").className).toContain("font-normal");
    expect(screen.getByTestId("settings-section-header-description").className).toContain("text-sm");
    expect(screen.getByTestId("settings-section-header-description").className).toContain("font-normal");
    expect(screen.queryByText("Connected", { selector: "h4" })).toBeNull();
    expect(screen.queryByText("Available", { selector: "h4" })).toBeNull();
    expect(screen.getByText("Manage repos, issues, and pull requests")).not.toBeNull();
    expect(screen.getByText("Send messages and manage channels")).not.toBeNull();
    expect(screen.getByText("Manage issues, projects & team workflows")).not.toBeNull();
    expect(screen.getByTestId("integration-card-slack").querySelector("p")?.className).toContain("text-md");
    expect(screen.getByText("Send messages and manage channels").className).toContain("text-sm");
    expect(screen.getByTestId("integration-action-slack").getAttribute("data-state")).toBe("connected");
    expect(screen.getByTestId("integration-action-github").getAttribute("data-state")).toBe("available");
    expect(screen.getByTestId("integration-connect-github").className).toContain("rounded-[8px]");
    expect(Array.from(screen.getByTestId("integrations-grid").querySelectorAll("[data-testid^='integration-card-']")).map((card) => card.getAttribute("data-testid"))).toEqual([
      "integration-card-slack",
      "integration-card-github",
      "integration-card-linear",
    ]);
  });

  it("capitalizes service ids in the connected section when no catalog name exists", async () => {
    useConnection.setState({
      api: makeApi({ available: [], connections: [{ ...GMAIL_CONNECTION, service: "google_calendar" }] }) as never,
    });
    render(<IntegrationsSettingsSection />);

    await waitFor(() => expect(screen.getByText(/Google Calendar/)).not.toBeNull());
  });

  it("shows connected accounts with label, email, and status", async () => {
    render(<IntegrationsSettingsSection />);
    await waitFor(() => expect(screen.getByText("Work")).not.toBeNull());

    expect(screen.getByText("work@example.com")).not.toBeNull();
    expect(screen.getByText("active")).not.toBeNull();
  });

  it("capitalizes raw connection labels in the connected section", async () => {
    useConnection.setState({
      api: makeApi({ connections: [{ ...GMAIL_CONNECTION, account_label: "gmail" }] }) as never,
    });
    render(<IntegrationsSettingsSection />);

    await waitFor(() => expect(screen.getAllByText("Gmail").length).toBeGreaterThan(0));
    expect(screen.queryByText(/^gmail$/)).toBeNull();
  });

  it("renders the shared Refresh recipe in the section header and reloads on click", async () => {
    const api = makeApi();
    useConnection.setState({ api: api as never });
    render(<IntegrationsSettingsSection />);
    await waitFor(() => expect(screen.getByText("Gmail")).not.toBeNull());

    // Same IconButton-with-label recipe as Providers: RefreshCw glyph plus
    // label in a subtle pill, top-right of the section header.
    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    expect(refreshButton.querySelector("svg")).not.toBeNull();

    const getMock = api.get as unknown as ReturnType<typeof vi.fn>;
    const callsBefore = getMock.mock.calls.length;
    fireEvent.click(refreshButton);
    await waitFor(() => expect(getMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("renders the unavailable empty state when the runtime does not expose integrations", async () => {
    useConnection.setState({
      api: makeApi({ getError: () => new AppError("notFound") }) as never,
    });
    render(<IntegrationsSettingsSection />);

    await waitFor(() =>
      expect(screen.getByText("Integrations are unavailable on this runtime.")).not.toBeNull(),
    );
    // Capability gate: no crash, no catalog, no connect buttons.
    expect(screen.queryByRole("button", { name: /Connect/i })).toBeNull();
  });

  it("shows a generic offline message with a retry that reloads", async () => {
    let failures = 0;
    const api = makeApi({
      getError: () => {
        failures += 1;
        return failures <= 2 ? new AppError("offline") : null;
      },
    });
    useConnection.setState({ api: api as never });
    render(<IntegrationsSettingsSection />);

    await waitFor(() =>
      expect(screen.getByText("Can't reach Matrix OS. Check your connection.")).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    await waitFor(() => expect(screen.getByText("Gmail")).not.toBeNull());
  });

  it("renders an empty-catalog state when the proxy has no services", async () => {
    useConnection.setState({
      api: makeApi({ available: [], connections: [] }) as never,
    });
    render(<IntegrationsSettingsSection />);

    await waitFor(() =>
      expect(screen.getByText("No integrations are available yet.")).not.toBeNull(),
    );
  });

  it("connects a service: posts to the proxy, opens the consent URL externally, and polls until connected", async () => {
    const api = makeApi({ syncServices: [GMAIL_CONNECTION, NEW_GMAIL_CONNECTION] });
    useConnection.setState({ api: api as never });
    render(<IntegrationsSettingsSection pollIntervals={[20, 20, 20, 20, 20]} />);

    await waitFor(() => expect(screen.getByText("GitHub")).not.toBeNull());
    fireEvent.click(screen.getByTestId("integration-connect-gmail"));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/api/integrations/connect", { service: "gmail" }),
    );
    expect(window.operator.invoke).toHaveBeenCalledWith("shell:open-external", {
      url: "https://pipedream.com/connect?token=abc",
    });

    // The poll syncs until the new account appears, then the section updates.
    await waitFor(() => expect(screen.getByText("Personal")).not.toBeNull(), { timeout: 3000 });
    expect(api.post).toHaveBeenCalledWith("/api/integrations/sync", {});
    expect(screen.queryByText(/waiting for/i)).toBeNull();
  });

  it("lets the user manually confirm with 'I've connected' while waiting", async () => {
    const api = makeApi({ syncServices: [GMAIL_CONNECTION, NEW_GMAIL_CONNECTION] });
    useConnection.setState({ api: api as never });
    // Long poll intervals: only the manual confirm should trigger the sync.
    render(<IntegrationsSettingsSection pollIntervals={[60_000, 60_000]} />);

    await waitFor(() => expect(screen.getByText("GitHub")).not.toBeNull());
    fireEvent.click(screen.getByTestId("integration-connect-gmail"));

    await waitFor(() => expect(screen.getByText(/waiting for/i)).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /I've connected/i }));

    await waitFor(() => expect(screen.getByText("Personal")).not.toBeNull());
    expect(api.post).toHaveBeenCalledWith("/api/integrations/sync", {});
    expect(screen.queryByText(/waiting for/i)).toBeNull();
  });

  it("cancels a pending connect without further syncing", async () => {
    const api = makeApi();
    useConnection.setState({ api: api as never });
    render(<IntegrationsSettingsSection pollIntervals={[60_000]} />);

    await waitFor(() => expect(screen.getByText("GitHub")).not.toBeNull());
    fireEvent.click(screen.getByTestId("integration-connect-gmail"));
    await waitFor(() => expect(screen.getByText(/waiting for/i)).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(screen.queryByText(/waiting for/i)).toBeNull();
    expect(api.post).not.toHaveBeenCalledWith("/api/integrations/sync", {});
  });

  it("keeps manual recovery controls after automatic polling times out", async () => {
    const api = makeApi({ connections: [], syncServices: [] });
    useConnection.setState({ api: api as never });
    render(<IntegrationsSettingsSection pollIntervals={[1]} />);

    await waitFor(() => expect(screen.getByText("Gmail")).not.toBeNull());
    fireEvent.click(screen.getByTestId("integration-connect-gmail"));

    await waitFor(() =>
      expect(screen.getByText(/Still waiting/i)).not.toBeNull(),
    );
    expect(screen.getByRole("button", { name: /I've connected/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Cancel/i })).not.toBeNull();
  });

  it("cancels a scheduled connect poll when the runtime client changes", async () => {
    const previousApi = makeApi({ connections: [], syncServices: [NEW_GMAIL_CONNECTION] });
    const nextApi = makeApi({ connections: [], syncServices: [] });
    useConnection.setState({ api: previousApi as never });
    render(<IntegrationsSettingsSection pollIntervals={[30]} />);

    await waitFor(() => expect(screen.getByText("Gmail")).not.toBeNull());
    fireEvent.click(screen.getByTestId("integration-connect-gmail"));
    await waitFor(() =>
      expect(previousApi.post).toHaveBeenCalledWith("/api/integrations/connect", { service: "gmail" }),
    );

    await act(async () => {
      advanceRuntimeGeneration();
      useConnection.setState({ api: nextApi as never });
      await new Promise((resolve) => window.setTimeout(resolve, 80));
    });

    expect(previousApi.post).not.toHaveBeenCalledWith("/api/integrations/sync", {});
    expect(screen.queryByText("Personal")).toBeNull();
  });

  it("disconnects an account after confirmation", async () => {
    const api = makeApi();
    useConnection.setState({ api: api as never });
    render(<IntegrationsSettingsSection />);

    await waitFor(() => expect(screen.getByText("Work")).not.toBeNull());
    fireEvent.click(screen.getByTestId(`integration-disconnect-${CONN_ID}`));

    // Confirm dialog first — destructive actions never fire immediately.
    await waitFor(() => expect(screen.getByText(/Disconnect Work\?/)).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^Disconnect$/ }));

    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith(`/api/integrations/${CONN_ID}`),
    );
    await waitFor(() => expect(screen.queryByText("Work")).toBeNull());
    expect(screen.queryByText(/Disconnect Work\?/)).toBeNull();
  });

  it("keeps the account and shows generic copy when disconnect fails", async () => {
    const api = makeApi({ deleteError: new AppError("server") });
    useConnection.setState({ api: api as never });
    render(<IntegrationsSettingsSection />);

    await waitFor(() => expect(screen.getByText("Work")).not.toBeNull());
    fireEvent.click(screen.getByTestId(`integration-disconnect-${CONN_ID}`));
    await waitFor(() => expect(screen.getByText(/Disconnect Work\?/)).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^Disconnect$/ }));

    await waitFor(() =>
      expect(screen.getByText("Something went wrong. Please try again.")).not.toBeNull(),
    );
    expect(screen.getByText("Work")).not.toBeNull();
  });
});
