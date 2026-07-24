// @vitest-environment jsdom

// Component tests for the desktop integrations settings section. The section
// mirrors the shell IntegrationsSection data flow against the gateway proxy
// routes /api/integrations* but stays renderer-only: OAuth consent opens via
// the HTTPS-only shell:open-external bridge and status polls go through the
// typed ApiClient (bearer injected by the trusted core at the network layer).
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntegrationsSettingsSection,
  useIntegrations,
} from "../../desktop/src/renderer/src/features/integrations";
import { AppError } from "../../desktop/src/shared/app-error";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";

const CONN_ID = "7d3f6f1e-2b3c-4a5d-8e9f-0a1b2c3d4e5f";
const NEW_CONN_ID = "8e4a7a2f-3c4d-5b6e-9f0a-1b2c3d4e5f60";

const AVAILABLE = [
  { id: "gmail", name: "Gmail", category: "google", icon: "mail", logoUrl: "https://cdn.test/gmail.png", actions: {} },
  { id: "github", name: "GitHub", category: "developer", icon: "code", actions: {} },
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

  it("lists available services with icon initials and no remote images", async () => {
    const { container } = render(<IntegrationsSettingsSection />);
    await waitFor(() => expect(screen.getByText("Gmail")).not.toBeNull());

    expect(screen.getByText("GitHub")).not.toBeNull();
    expect(screen.getByText("google")).not.toBeNull();
    // Icon initial tile, never the remote logoUrl from the proxy payload.
    expect(screen.getByTestId("integration-icon-gmail").textContent).toBe("G");
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows connected accounts with label, email, and status", async () => {
    render(<IntegrationsSettingsSection />);
    await waitFor(() => expect(screen.getByText("Work")).not.toBeNull());

    expect(screen.getByText("work@example.com")).not.toBeNull();
    expect(screen.getByText("active")).not.toBeNull();
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
