// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Community from "../../home/apps/app-gallery/src/store/Community";
import DraftDetail from "../../home/apps/app-gallery/src/store/DraftDetail";
import ListingDetail from "../../home/apps/app-gallery/src/store/ListingDetail";
import Publish from "../../home/apps/app-gallery/src/store/Publish";
import { createStoreClient } from "../../home/apps/app-gallery/src/store-model";
import {
  draft,
  draftSummary,
  id,
  listing,
  secondId,
  summary,
} from "./app-store-fixtures";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function bridge(route: (url: string, body?: unknown) => unknown) {
  return {
    gatewayFetch: vi.fn(async (url: string, init?: { body?: string }) =>
      route(url, init?.body ? JSON.parse(init.body) : undefined),
    ),
    openApp: vi.fn(),
  };
}
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.useRealTimers();
});

describe("Gallery frontend recovery", () => {
  it("returns from a paginated listing to a fresh first catalog page", async () => {
    const b = bridge((url) =>
      url.includes("/listings?")
        ? url.includes("cursor=")
          ? {
              listings: [
                {
                  ...summary(),
                  id: secondId,
                  slug: "second-notes",
                  name: "Second Notes",
                },
              ],
            }
          : { listings: [summary()], nextCursor: "nextpage" }
        : { ...listing, slug: "second-notes", name: "Second Notes" },
    );
    render(<Community client={createStoreClient(b)} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Load more apps" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Second Notes" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Back to community/ }),
    );
    await waitFor(() =>
      expect(
        b.gatewayFetch.mock.calls
          .filter((call) => call[0].includes("/listings?"))
          .at(-1)?.[0],
      ).not.toContain("cursor="),
    );
    expect(
      await screen.findByRole("button", { name: "Sample Notes" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Second Notes" })).toBeNull();
  });

  it("ignores an old diff after revision and refuses file reads while preparing", async () => {
    const oldDiff = deferred<unknown>();
    let current = structuredClone(draft);
    const b = bridge((url) => {
      if (url.includes("/diff?")) return oldDiff.promise;
      if (url.endsWith("/revise")) {
        current = {
          ...current,
          status: "preparing",
          updatedAt: "2026-10-18T10:01:00Z",
        };
        return {
          ...draftSummary(),
          status: "preparing",
          updatedAt: current.updatedAt,
        };
      }
      return current;
    });
    render(
      <DraftDetail
        client={createStoreClient(b)}
        id={id}
        accessSourceId="provider1"
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "src/App.tsx" }));
    fireEvent.change(screen.getByLabelText("Ask for a revision"), {
      target: { value: "Make it generic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revise copy" }));
    await screen.findByText(/preparing · verify/);
    fireEvent.click(screen.getByRole("button", { name: "src/App.tsx" }));
    expect(
      b.gatewayFetch.mock.calls.filter((call) => call[0].includes("/diff?"))
        .length,
    ).toBe(1);
    await act(async () =>
      oldDiff.resolve({
        path: "src/App.tsx",
        change: "modified",
        binary: false,
        truncated: false,
        before: "Old source",
        after: "STALE REVISION",
      }),
    );
    expect(screen.queryByText("STALE REVISION")).toBeNull();
  });

  it("invalidates a pending diff when a saved draft changes its server revision", async () => {
    const oldDiff = deferred<unknown>();
    const b = bridge((url) =>
      url.includes("/diff?")
        ? oldDiff.promise
        : url.endsWith("/listing")
          ? { ...draft, updatedAt: "2026-10-18T10:02:00Z" }
          : draft,
    );
    render(
      <DraftDetail client={createStoreClient(b)} id={id} onBack={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "src/App.tsx" }));
    fireEvent.click(screen.getByRole("button", { name: "Save listing" }));
    await screen.findByText(/Listing saved/);
    await act(async () =>
      oldDiff.resolve({
        path: "src/App.tsx",
        change: "modified",
        binary: false,
        truncated: false,
        before: "Old source",
        after: "STALE SAVED SOURCE",
      }),
    );
    expect(screen.queryByText("STALE SAVED SOURCE")).toBeNull();
  });

  it("recovers a transient install status failure and opens after the next poll", async () => {
    let polls = 0,
      installed = false;
    const b = bridge((url) => {
      if (url.includes("/installs/")) {
        if (++polls === 1) throw new Error("Temporary transport failure");
        installed = true;
        return {
          id,
          status: "installed",
          appSlug: listing.slug,
          launchPath: `apps/${listing.slug}`,
        };
      }
      if (url.endsWith("/install")) return { id, status: "building" };
      return {
        ...listing,
        local: {
          installed,
          updateAvailable: false,
          ...(installed ? { launchPath: `apps/${listing.slug}` } : {}),
        },
      };
    });
    render(
      <ListingDetail
        client={createStoreClient(b)}
        slug={listing.slug}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Get app" }));
    fireEvent.click(screen.getByLabelText(/I agree to these capabilities/));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Install source" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(polls).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(polls).toBe(2);
    expect(screen.getByRole("button", { name: "Open app" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("caps automatic status retries and offers an explicit recovery action", async () => {
    let polls = 0,
      recovered = false;
    const b = bridge((url) => {
      if (url.includes("/installs/")) {
        polls++;
        if (!recovered) throw new Error("Disconnected");
        return {
          id,
          status: "installed",
          appSlug: listing.slug,
          launchPath: `apps/${listing.slug}`,
        };
      }
      if (url.endsWith("/install")) return { id, status: "building" };
      return {
        ...listing,
        local: {
          installed: recovered,
          updateAvailable: false,
          ...(recovered ? { launchPath: `apps/${listing.slug}` } : {}),
        },
      };
    });
    const { unmount } = render(
      <ListingDetail
        client={createStoreClient(b)}
        slug={listing.slug}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Get app" }));
    fireEvent.click(screen.getByLabelText(/I agree to these capabilities/));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Install source" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(polls).toBe(4);
    recovered = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry build status" }));
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(screen.getByRole("button", { name: "Open app" })).toBeTruthy();
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(polls).toBe(5);
  });

  it("keeps existing drafts unavailable until a pending creation settles", async () => {
    const created = deferred<unknown>();
    const b = bridge((url) =>
      url.endsWith("publishable-apps")
        ? { apps: [{ slug: "new-notes", name: "New notes", eligible: true }] }
        : url.endsWith("/drafts")
          ? { drafts: [draftSummary()] }
          : draft,
    );
    const client = createStoreClient(b);
    vi.spyOn(client, "createDraft").mockImplementation(
      () => created.promise as ReturnType<typeof client.createDraft>,
    );
    render(
      <Publish
        client={client}
        status={{ enabled: true, reviewer: false, signingKeys: [] }}
      />,
    );
    fireEvent.change(await screen.findByLabelText("App to publish"), {
      target: { value: "new-notes" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Prepare shareable copy" }),
    );
    const existing = screen.getByRole("button", {
      name: /My notes · ready/,
    }) as HTMLButtonElement;
    expect(existing.disabled).toBe(true);
    fireEvent.click(existing);
    expect(screen.queryByLabelText("Tagline")).toBeNull();
    await act(async () => created.resolve(draftSummary() as unknown));
    expect(await screen.findByLabelText("Tagline")).toBeTruthy();
  });
});
