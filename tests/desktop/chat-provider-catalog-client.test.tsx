// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanonicalProviderCatalogSchema } from "@matrix-os/contracts";
import type { ApiClient } from "../../desktop/src/renderer/src/lib/api";
import {
  fetchCanonicalProviderCatalog,
  useChatProviderCatalog,
} from "../../desktop/src/renderer/src/features/chat/chat-provider-catalog";

const emptyCatalog = CanonicalProviderCatalogSchema.parse({
  revision: "catalog_empty",
  drivers: [],
  instances: [],
});

function apiReturning(value: unknown): ApiClient {
  return {
    baseUrl: "https://platform.test",
    get: vi.fn(async () => value),
  } as unknown as ApiClient;
}

describe("Desktop canonical Provider catalog client", () => {
  afterEach(() => cleanup());

  it("loads and validates the bounded gateway catalog", async () => {
    const api = apiReturning(emptyCatalog);

    await expect(fetchCanonicalProviderCatalog(api)).resolves.toEqual(emptyCatalog);
    expect(api.get).toHaveBeenCalledWith("/api/chat-providers");
  });

  it("can force a live provider refresh after terminal configuration", async () => {
    const catalog = CanonicalProviderCatalogSchema.parse({
      revision: "catalog_refreshed",
      drivers: [],
      instances: [],
    });
    const api = apiReturning(catalog);

    await fetchCanonicalProviderCatalog(api, true);

    expect(api.get).toHaveBeenCalledWith("/api/chat-providers?refresh=true");
  });

  it("rejects malformed gateway data instead of projecting it into controls", async () => {
    const api = apiReturning({ revision: "catalog_bad", drivers: [], instances: "secret" });
    await expect(fetchCanonicalProviderCatalog(api)).rejects.toThrow();
  });

  it("revalidates only while the Chat surface is in the foreground", async () => {
    const refreshedCatalog = { ...emptyCatalog, revision: "catalog_refreshed" };
    const api = apiReturning(refreshedCatalog);
    function CatalogProbe({ active }: { active: boolean }) {
      const state = useChatProviderCatalog(emptyCatalog, { api, active });
      return <output>{`${state.status}:${state.catalog.revision}`}</output>;
    }

    const view = render(<CatalogProbe active={false} />);
    await act(async () => undefined);
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.getByText("fallback:catalog_empty")).not.toBeNull();

    view.rerender(<CatalogProbe active />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    expect(api.get).toHaveBeenLastCalledWith("/api/chat-providers?refresh=true");
    expect(await screen.findByText("ready:catalog_refreshed")).not.toBeNull();

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(api.get).toHaveBeenLastCalledWith("/api/chat-providers?refresh=true");

    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    expect(api.get).toHaveBeenLastCalledWith("/api/chat-providers?refresh=true");

    view.rerender(<CatalogProbe active={false} />);
    act(() => window.dispatchEvent(new Event("focus")));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => undefined);
    expect(api.get).toHaveBeenCalledTimes(3);
  });
});
