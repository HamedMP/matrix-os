// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SystemSection from "../../desktop/src/renderer/src/features/settings/sections/SystemSection";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { advanceRuntimeGeneration } from "../../desktop/src/renderer/src/stores/runtime-generation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function makeApi() {
  return {
    baseUrl: "https://app.matrix-os.com",
    get: vi.fn(async (path: string) => {
      if (path === "/api/system/info") {
        return { version: "0.1.0", updateChannel: "stable", release: { version: "v2026.08.20", channel: "stable" } };
      }
      if (path === "/api/system/update?channel=stable") {
        return { channel: "stable", latest: { version: "v2026.08.28", channel: "stable" }, updateAvailable: true };
      }
      if (path === "/api/system/releases?channel=stable") {
        return {
          channel: "stable",
          generatedAt: "2026-08-28T00:00:00.000Z",
          releases: [
            { version: "v2026.08.28", channel: "stable", gitCommit: "0123456789abcdef", changelog: "Bug fixes" },
            { version: "v2026.08.10", channel: "stable", gitCommit: "fedcba9876543210", changelog: "Earlier release" },
          ],
        };
      }
      throw new Error(`Unexpected GET ${path}`);
    }),
    post: vi.fn(async () => ({ ok: true, status: "started", version: "v2026.08.28" })),
    getText: vi.fn(),
    getBlob: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
  };
}

describe("desktop system updates", () => {
  beforeEach(() => {
    useConnection.setState({ api: makeApi() as never });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads release channels and available versions", async () => {
    render(<SystemSection />);

    await waitFor(() => expect(screen.getAllByText("v2026.08.28").length).toBeGreaterThan(0));
    expect(screen.getByLabelText("Release channel")).not.toBeNull();
    expect(screen.getByText("Build ID 0123456789ab")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Downgrade to v2026.08.10" })).not.toBeNull();
  });

  it("starts an upgrade for a selected release version", async () => {
    const api = makeApi();
    useConnection.setState({ api: api as never });
    render(<SystemSection />);

    await waitFor(() => expect(screen.getAllByText("v2026.08.28").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to v2026.08.28" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/system/update", { version: "v2026.08.28" }, expect.anything()));
    expect(screen.getByRole("status", { name: /Installing v2026\.08\.28/i })).not.toBeNull();
  });

  it("continues update polling when mounted in StrictMode", async () => {
    let installed = false;
    const api = {
      ...makeApi(),
      get: vi.fn(async (path: string) => {
        if (path === "/api/system/info") {
          return installed
            ? { release: { version: "v2026.08.28", channel: "stable" } }
            : { release: { version: "v2026.08.20", channel: "stable" } };
        }
        if (path === "/api/system/update?channel=stable") return { latest: { version: "v2026.08.28", channel: "stable" }, updateAvailable: true };
        if (path === "/api/system/releases?channel=stable") return { releases: [] };
        throw new Error(`Unexpected GET ${path}`);
      }),
      post: vi.fn(async () => { installed = true; return { ok: true, version: "v2026.08.28" }; }),
    };
    useConnection.setState({ api: api as never });
    render(<React.StrictMode><SystemSection /></React.StrictMode>);

    await waitFor(() => expect(screen.getByRole("button", { name: "Upgrade" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    await waitFor(() => expect(screen.getByText("Update installed successfully.")).not.toBeNull());
  });

  it("does not treat an unchanged channel subscription as an installed channel update", async () => {
    const api = makeApi();
    useConnection.setState({ api: api as never });
    render(<SystemSection />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Upgrade" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    await waitFor(() => expect((api.get as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]) => path === "/api/system/info").length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole("status", { name: /Installing v2026\.08\.28/i })).not.toBeNull();
    expect(screen.queryByText("Update installed successfully.")).toBeNull();
  });

  it("accepts a changed installed release even when its artifact channel differs", async () => {
    let installed = false;
    const api = {
      ...makeApi(),
      get: vi.fn(async (path: string) => {
        if (path === "/api/system/info") {
          return installed
            ? { release: { version: "v2026.08.28", channel: "dev" } }
            : { release: { version: "v2026.08.20", channel: "stable" } };
        }
        if (path === "/api/system/update?channel=stable") return { latest: { version: "v2026.08.28", channel: "stable" }, updateAvailable: true };
        if (path === "/api/system/releases?channel=stable") return { releases: [] };
        throw new Error(`Unexpected GET ${path}`);
      }),
      post: vi.fn(async () => { installed = true; return { ok: true, version: "v2026.08.28" }; }),
    };
    useConnection.setState({ api: api as never });
    render(<SystemSection />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Upgrade" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    await waitFor(() => expect(screen.getByText("Update installed successfully.")).not.toBeNull());
    expect(screen.queryByRole("status", { name: /Installing stable/i })).toBeNull();
  });

  it("does not report a channel update as installed for an unrelated version", async () => {
    let updateStarted = false;
    const api = {
      ...makeApi(),
      get: vi.fn(async (path: string) => {
        if (path === "/api/system/info") {
          return updateStarted
            ? { release: { version: "v2026.08.27", channel: "dev" } }
            : { release: { version: "v2026.08.20", channel: "stable" } };
        }
        if (path === "/api/system/update?channel=stable") return { latest: { version: "v2026.08.28", channel: "stable" }, updateAvailable: true };
        if (path === "/api/system/releases?channel=stable") return { releases: [] };
        throw new Error(`Unexpected GET ${path}`);
      }),
      post: vi.fn(async () => { updateStarted = true; return { ok: true, version: "v2026.08.28" }; }),
    };
    useConnection.setState({ api: api as never });
    render(<SystemSection />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Upgrade" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    await waitFor(() => expect((api.get as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]) => path === "/api/system/info").length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole("status", { name: /Installing v2026\.08\.28/i })).not.toBeNull();
    expect(screen.queryByText("Update installed successfully.")).toBeNull();
  });

  it("accepts the version resolved when starting a channel update", async () => {
    let updateStarted = false;
    const api = {
      ...makeApi(),
      get: vi.fn(async (path: string) => {
        if (path === "/api/system/info") {
          return updateStarted
            ? { release: { version: "v2026.08.29", channel: "stable" } }
            : { release: { version: "v2026.08.20", channel: "stable" } };
        }
        if (path === "/api/system/update?channel=stable") return { latest: { version: "v2026.08.28", channel: "stable" }, updateAvailable: true };
        if (path === "/api/system/releases?channel=stable") return { releases: [] };
        throw new Error(`Unexpected GET ${path}`);
      }),
      post: vi.fn(async () => { updateStarted = true; return { ok: true, version: "v2026.08.29" }; }),
    };
    useConnection.setState({ api: api as never });
    render(<SystemSection />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Upgrade" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    await waitFor(() => expect(screen.getByText("Update installed successfully.")).not.toBeNull());
  });

  it("invalidates release data while the active runtime has no API", async () => {
    const stableUpdate = deferred<unknown>();
    const stableReleases = deferred<unknown>();
    const api = {
      ...makeApi(),
      get: vi.fn((path: string) => {
        if (path === "/api/system/info") return Promise.resolve({ release: { version: "v2026.08.20", channel: "stable" } });
        if (path === "/api/system/update?channel=stable") return stableUpdate.promise;
        if (path === "/api/system/releases?channel=stable") return stableReleases.promise;
        throw new Error(`Unexpected GET ${path}`);
      }),
    };
    useConnection.setState({ api: api as never, runtimeSlot: "primary" });
    render(<SystemSection />);

    await waitFor(() => expect((api.get as ReturnType<typeof vi.fn>).mock.calls
      .some(([path]) => path === "/api/system/releases?channel=stable")).toBe(true));
    await act(async () => {
      useConnection.setState({ api: null, runtimeSlot: "review" });
      stableUpdate.resolve({ latest: { version: "v2026.08.28", channel: "stable" }, updateAvailable: true });
      stableReleases.resolve({ releases: [{ version: "v2026.08.28", channel: "stable" }] });
      await Promise.resolve();
    });

    expect(screen.queryAllByText("v2026.08.28")).toHaveLength(0);
  });

  it("does not show an old runtime's failed update on the new runtime", async () => {
    const pendingUpdate = deferred<unknown>();
    const api = { ...makeApi(), post: vi.fn(() => pendingUpdate.promise) };
    useConnection.setState({ api: api as never, runtimeSlot: "primary" });
    render(<SystemSection />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Upgrade" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    await act(async () => {
      advanceRuntimeGeneration();
      useConnection.setState({ runtimeSlot: "review" });
      pendingUpdate.resolve(Promise.reject(new Error("request failed")));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByText("The update could not be started.")).toBeNull());
  });

  it("ignores an update poll after the active runtime changes", async () => {
    const pendingPoll = deferred<unknown>();
    let infoRequests = 0;
    const api = {
      ...makeApi(),
      get: vi.fn((path: string) => {
        if (path === "/api/system/info") {
          infoRequests += 1;
          return infoRequests === 1
            ? Promise.resolve({ release: { version: "v2026.08.20", channel: "stable" } })
            : pendingPoll.promise;
        }
        if (path === "/api/system/update?channel=stable") return Promise.resolve({ latest: { version: "v2026.08.28", channel: "stable" }, updateAvailable: true });
        if (path === "/api/system/releases?channel=stable") return Promise.resolve({ releases: [] });
        throw new Error(`Unexpected GET ${path}`);
      }),
    };
    useConnection.setState({ api: api as never, runtimeSlot: "primary" });
    render(<SystemSection />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Upgrade" })).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
    await waitFor(() => expect(infoRequests).toBe(2));
    await act(async () => {
      advanceRuntimeGeneration();
      useConnection.setState({ runtimeSlot: "review" });
      pendingPoll.resolve({ release: { version: "v2026.08.28", channel: "stable" } });
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByText("Update installed successfully.")).toBeNull());
  });

  it("keeps the newest channel's releases when an earlier request finishes last", async () => {
    const stableUpdate = deferred<unknown>();
    const stableReleases = deferred<unknown>();
    const api = {
      ...makeApi(),
      get: vi.fn((path: string) => {
        if (path === "/api/system/info") return Promise.resolve({ release: { version: "v2026.08.20", channel: "stable" } });
        if (path === "/api/system/update?channel=stable") return stableUpdate.promise;
        if (path === "/api/system/releases?channel=stable") return stableReleases.promise;
        if (path === "/api/system/update?channel=canary") return Promise.resolve({ latest: { version: "v2026.08.29-canary", channel: "canary" }, updateAvailable: true });
        if (path === "/api/system/releases?channel=canary") return Promise.resolve({ releases: [{ version: "v2026.08.29-canary", channel: "canary" }] });
        throw new Error(`Unexpected GET ${path}`);
      }),
    };
    useConnection.setState({ api: api as never });
    render(<SystemSection />);

    await waitFor(() => expect((api.get as ReturnType<typeof vi.fn>).mock.calls
      .some(([path]) => path === "/api/system/releases?channel=stable")).toBe(true));
    fireEvent.change(screen.getByLabelText("Release channel"), { target: { value: "canary" } });
    await waitFor(() => expect(screen.getAllByText("v2026.08.29-canary").length).toBeGreaterThan(0));

    stableUpdate.resolve({ latest: { version: "v2026.08.28", channel: "stable" }, updateAvailable: true });
    stableReleases.resolve({ releases: [{ version: "v2026.08.28", channel: "stable" }] });
    await Promise.resolve();

    expect(screen.getAllByText("v2026.08.29-canary").length).toBeGreaterThan(0);
    expect(screen.queryByText("v2026.08.28")).toBeNull();
  });
});
