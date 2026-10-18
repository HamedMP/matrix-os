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
