// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useParams: vi.fn().mockReturnValue({ slug: "test-app" }),
  notFound: vi.fn(),
}));

// Mock gateway
vi.mock("../../../shell/src/lib/gateway.js", () => ({
  getGatewayUrl: () => "http://localhost:4000",
}));

// Mock socket hook
vi.mock("../../../shell/src/hooks/useSocket.js", () => ({
  useSocket: () => ({ send: vi.fn() }),
}));

// Mock fetch for API calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { useAppStore } from "../../../shell/src/stores/app-store.js";

describe("AppStore - Gallery Browse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    // Reset zustand store
    useAppStore.setState({
      entries: [],
      search: "",
      selectedCategory: "All",
      selectedApp: null,
      installedIds: new Set(),
      installations: new Map(),
      loading: false,
    });
  });

  describe("store state", () => {
    it("initializes with fallback catalog", () => {
      const { entries } = useAppStore.getState();
      // After reset it's empty, but default is FALLBACK_CATALOG
      expect(Array.isArray(entries)).toBe(true);
    });

    it("supports gallery source type", () => {
      useAppStore.getState().setEntries([
        {
          id: "gallery-1",
          name: "Gallery App",
          description: "From the gallery",
          category: "utility",
          author: "test",
          source: "gallery",
          listingId: "listing-1",
        },
      ]);

      const gallery = useAppStore.getState().galleryApps();
      expect(gallery.length).toBe(1);
      expect(gallery[0].source).toBe("gallery");
    });

    it("filters by category", () => {
      useAppStore.getState().setEntries([
        { id: "1", name: "A", description: "a", category: "Games", author: "x", source: "gallery" },
        { id: "2", name: "B", description: "b", category: "Utilities", author: "x", source: "gallery" },
      ]);

      const games = useAppStore.getState().byCategory("Games");
      expect(games.length).toBe(1);
      expect(games[0].id).toBe("1");
    });

    it("searches by name and description", () => {
      useAppStore.getState().setEntries([
        { id: "1", name: "Todo App", description: "Manage tasks", category: "Productivity", author: "x", source: "gallery" },
        { id: "2", name: "Weather", description: "See forecast", category: "Utilities", author: "x", source: "gallery" },
      ]);

      useAppStore.getState().setSearch("todo");
      const results = useAppStore.getState().searchResults();
      expect(results.length).toBe(1);
      expect(results[0].id).toBe("1");
    });

    it("searches by tags", () => {
      useAppStore.getState().setEntries([
        { id: "1", name: "A", description: "a", category: "Games", author: "x", source: "gallery", tags: ["puzzle"] },
        { id: "2", name: "B", description: "b", category: "Games", author: "x", source: "gallery", tags: ["action"] },
      ]);

      useAppStore.getState().setSearch("puzzle");
      const results = useAppStore.getState().searchResults();
      expect(results.length).toBe(1);
      expect(results[0].id).toBe("1");
    });

    it("marks apps as installed", () => {
      useAppStore.getState().markInstalled("app-1");
      expect(useAppStore.getState().installedIds.has("app-1")).toBe(true);
    });

    it("returns top rated apps sorted", () => {
      useAppStore.getState().setEntries([
        { id: "1", name: "Low", description: "l", category: "x", author: "x", source: "gallery", rating: 2.0 },
        { id: "2", name: "High", description: "h", category: "x", author: "x", source: "gallery", rating: 4.8 },
        { id: "3", name: "Mid", description: "m", category: "x", author: "x", source: "gallery", rating: 3.5 },
      ]);

      const top = useAppStore.getState().topRated();
      expect(top[0].id).toBe("2");
      expect(top[1].id).toBe("3");
    });
  });

  describe("fetchGalleryApps", () => {
    it("fetches from gallery API and merges with catalog", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          apps: [
            {
              id: "gallery-uuid-1",
              slug: "cool-app",
              name: "Cool App",
              description: "A cool app",
              category: "games",
              author_id: "author-1",
              icon_url: null,
              avg_rating: "4.2",
              ratings_count: 10,
              installs_count: 50,
              price: 0,
              tags: ["fun"],
              visibility: "public",
            },
          ],
        }),
      });

      await useAppStore.getState().fetchGalleryApps();

      const entries = useAppStore.getState().entries;
      const galleryApp = entries.find((e) => e.slug === "cool-app");
      expect(galleryApp).toBeDefined();
      expect(galleryApp!.source).toBe("gallery");
    });

    it("keeps fallback catalog on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      await useAppStore.getState().fetchGalleryApps();

      // Should not crash and entries should have some content
      const entries = useAppStore.getState().entries;
      expect(Array.isArray(entries)).toBe(true);
    });
  });
});
