// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import ListingDetail from "../../home/apps/app-gallery/src/store/ListingDetail";
import { createStoreClient } from "../../home/apps/app-gallery/src/store-model";
import { id, listing } from "./app-store-fixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function unavailableStorage() {
  return vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
    throw new DOMException("Opaque frame", "SecurityError");
  });
}
it("recovers a pending build after a complete Gallery remount with opaque-frame storage", async () => {
  const storage = unavailableStorage();
  let current: {
    id: string;
    status: string;
    appSlug?: string;
    launchPath?: string;
  } | null = null;
  let installed = false;
  const gatewayFetch = vi.fn(async (url: string) => {
    if (url.endsWith("/install")) return (current = { id, status: "building" });
    if (url.includes("/installs/")) {
      installed = true;
      return (current = {
        id,
        status: "installed",
        appSlug: listing.slug,
        launchPath: `apps/${listing.slug}`,
      });
    }
    return {
      ...listing,
      ...(current ? { installJob: current } : {}),
      local: {
        installed,
        updateAvailable: false,
        ...(installed ? { launchPath: `apps/${listing.slug}` } : {}),
      },
    };
  });
  const openApp = vi.fn();
  const mount = () =>
    render(
      <ListingDetail
        client={createStoreClient({ gatewayFetch, openApp })}
        slug={listing.slug}
        onBack={vi.fn()}
      />,
    );
  const first = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Get app" }));
  fireEvent.click(screen.getByLabelText(/I agree to these capabilities/));
  fireEvent.click(screen.getByRole("button", { name: "Install source" }));
  await screen.findByText(/Building on your Matrix computer/);
  first.unmount();
  vi.useFakeTimers();
  mount();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByText(/Building on your Matrix computer/)).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Get app" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  vi.useRealTimers();
  fireEvent.click(await screen.findByRole("button", { name: "Open app" }));
  await waitFor(() => expect(openApp).toHaveBeenCalled());
  expect(
    gatewayFetch.mock.calls.filter(([url]) => url.endsWith("/install")),
  ).toHaveLength(1);
  expect(storage).not.toHaveBeenCalled();
});
it("shows a build failure discovered on reopen without polling or starting another build", async () => {
  unavailableStorage();
  const gatewayFetch = vi.fn(async () => ({
    ...listing,
    installJob: { id, status: "failed", error: "build_failed" },
  }));
  render(
    <ListingDetail
      client={createStoreClient({ gatewayFetch, openApp: vi.fn() })}
      slug={listing.slug}
      onBack={vi.fn()}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("local build did not finish"),
  );
  expect(
    (screen.getByRole("button", { name: "Get app" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(gatewayFetch).toHaveBeenCalledTimes(1);
});

it.each(["rating", "open"] as const)(
  "keeps a failed %s action visible when build polling recovers and refreshes details",
  async (action) => {
    let polls = 0;
    const gatewayFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/rating")) return { error: "forbidden" };
      if (url.includes("/installs/")) {
        if (++polls === 1) throw new Error("Disconnected");
        return {
          id,
          status: polls === 2 ? "building" : "installed",
          appSlug: listing.slug,
          launchPath: `apps/${listing.slug}`,
        };
      }
      return {
        ...listing,
        installJob: { id, status: polls >= 3 ? "installed" : "building" },
        myRating: 4,
        local: {
          installed: true,
          updateAvailable: polls < 3,
          launchPath: `apps/${listing.slug}`,
        },
      };
    });
    const openApp = vi.fn(async () => {
      throw new Error("Host app unavailable");
    });
    vi.useFakeTimers();
    render(
      <ListingDetail
        client={createStoreClient({ gatewayFetch, openApp })}
        slug={listing.slug}
        onBack={vi.fn()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: action === "rating" ? "Rate 5 stars" : "Open app",
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const message = screen.getByRole("alert").textContent;
    expect(message).toContain(
      action === "rating"
        ? "do not have access"
        : "unavailable on your Matrix computer",
    );
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(
      screen
        .getAllByRole("alert")
        .some((alert) => alert.textContent === message),
    ).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(polls).toBe(3);
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(
      screen.queryByRole("button", { name: "Retry build status" }),
    ).toBeNull();
  },
);

it("offers retry when all initial status polls fail for a durable job restored on reopen", async () => {
  unavailableStorage();
  let polls = 0,
    recovered = false;
  const gatewayFetch = vi.fn(async (url: string) => {
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
    return {
      ...listing,
      installJob: { id, status: recovered ? "installed" : "building" },
      local: {
        installed: recovered,
        updateAvailable: false,
        ...(recovered ? { launchPath: `apps/${listing.slug}` } : {}),
      },
    };
  });
  vi.useFakeTimers();
  render(
    <ListingDetail
      client={createStoreClient({ gatewayFetch, openApp: vi.fn() })}
      slug={listing.slug}
      onBack={vi.fn()}
    />,
  );
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
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    gatewayFetch.mock.calls.some(([url]) => url.endsWith("/install")),
  ).toBe(false);
});
