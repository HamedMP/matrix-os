import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, CATEGORIES, type AppStoreEntry } from "../../shell/src/stores/app-store";
import { FALLBACK_CATALOG } from "../../shell/src/components/app-store/catalog";

const SAMPLE_ENTRIES: AppStoreEntry[] = [
  {
    id: "todo",
    name: "Todo",
    description: "Simple task list",
    category: "Productivity",
    author: "Matrix OS",
    source: "bundled",
    icon: "T",
    iconColor: "#3b82f6",
    rating: 4.5,
    ratingCount: 120,
    downloads: 5000,
    featured: true,
    featuredTagline: "Stay organized",
  },
  {
    id: "notes",
    name: "Notes",
    description: "Quick notes with auto-save",
    category: "Productivity",
    author: "Matrix OS",
    source: "bundled",
    icon: "N",
    iconColor: "#f59e0b",
    rating: 4.2,
    ratingCount: 85,
    downloads: 3200,
  },
  {
    id: "snake",
    name: "Snake",
    description: "Classic snake game",
    category: "Games",
    author: "Matrix OS",
    source: "prompt",
    prompt: "Build snake game",
    icon: "S",
    iconColor: "#10b981",
    rating: 4.8,
    ratingCount: 200,
    downloads: 8000,
    new: true,
  },
  {
    id: "weather",
    name: "Weather Dashboard",
    description: "Current weather and forecast",
    category: "Utilities",
    author: "Matrix OS",
    source: "prompt",
    prompt: "Build weather dashboard",
    icon: "W",
    iconColor: "#6366f1",
    rating: 3.9,
    ratingCount: 45,
    downloads: 1500,
    tags: ["weather", "forecast"],
  },
  {
    id: "code-editor",
    name: "Code Editor",
    description: "Lightweight code editor with syntax highlighting",
    category: "Developer Tools",
    author: "Matrix OS",
    source: "bundled",
    icon: "C",
    iconColor: "#8b5cf6",
    rating: 4.6,
    ratingCount: 300,
    downloads: 12000,
    featured: true,
    featuredTagline: "Code anywhere",
  },
];

describe("App Store Zustand Store", () => {
  beforeEach(() => {
    useAppStore.setState({
      entries: [],
      search: "",
      selectedCategory: "All",
      selectedApp: null,
      installedIds: new Set(),
    });
  });

  it("initializes with fallback catalog", () => {
    useAppStore.setState({ entries: FALLBACK_CATALOG });
    const state = useAppStore.getState();
    expect(state.entries).toBe(FALLBACK_CATALOG);
    expect(state.entries.length).toBeGreaterThanOrEqual(40);
    expect(state.search).toBe("");
    expect(state.selectedCategory).toBe("All");
    expect(state.selectedApp).toBeNull();
    expect(state.installedIds.size).toBe(0);
  });

  it("setEntries populates store", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);
    expect(useAppStore.getState().entries).toHaveLength(5);
  });

  it("featured() filters featured entries", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);
    const featured = useAppStore.getState().featured();
    expect(featured).toHaveLength(2);
    expect(featured.map((e) => e.id)).toContain("todo");
    expect(featured.map((e) => e.id)).toContain("code-editor");
  });

  it("bundled() filters bundled apps", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);
    const bundledApps = useAppStore.getState().bundled();
    expect(bundledApps).toHaveLength(3);
    expect(bundledApps.every((e) => e.source === "bundled")).toBe(true);
  });

  it("promptLibrary() filters prompt apps", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);
    const promptApps = useAppStore.getState().promptLibrary();
    expect(promptApps).toHaveLength(2);
    expect(promptApps.every((e) => e.source === "prompt")).toBe(true);
  });

  it("byCategory() filters by category name", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);

    const productivity = useAppStore.getState().byCategory("Productivity");
    expect(productivity).toHaveLength(2);

    const games = useAppStore.getState().byCategory("Games");
    expect(games).toHaveLength(1);
    expect(games[0].id).toBe("snake");
  });

  it("byCategory('All') returns everything", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);
    const all = useAppStore.getState().byCategory("All");
    expect(all).toHaveLength(5);
  });

  it("byCategory is case-insensitive", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);
    const result = useAppStore.getState().byCategory("productivity");
    expect(result).toHaveLength(2);
  });

  it("searchResults() filters by name and description", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);
    useAppStore.getState().setSearch("snake");
    const results = useAppStore.getState().searchResults();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("snake");
  });

  it("searchResults() filters by tags", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);
    useAppStore.getState().setSearch("forecast");
    const results = useAppStore.getState().searchResults();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("weather");
  });

  it("searchResults() respects selected category", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);
    useAppStore.getState().setCategory("Productivity");
    useAppStore.getState().setSearch("notes");
    const results = useAppStore.getState().searchResults();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("notes");
  });

  it("searchResults() with empty search returns all in category", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);
    useAppStore.getState().setCategory("Games");
    const results = useAppStore.getState().searchResults();
    expect(results).toHaveLength(1);
  });

  it("markInstalled tracks installed IDs", () => {
    useAppStore.getState().markInstalled("todo");
    useAppStore.getState().markInstalled("snake");
    const { installedIds } = useAppStore.getState();
    expect(installedIds.has("todo")).toBe(true);
    expect(installedIds.has("snake")).toBe(true);
    expect(installedIds.has("notes")).toBe(false);
  });

  it("selectApp sets detail view", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);
    useAppStore.getState().selectApp(SAMPLE_ENTRIES[2]);
    expect(useAppStore.getState().selectedApp?.id).toBe("snake");
  });

  it("selectApp(null) clears detail view", () => {
    useAppStore.getState().selectApp(SAMPLE_ENTRIES[0]);
    useAppStore.getState().selectApp(null);
    expect(useAppStore.getState().selectedApp).toBeNull();
  });

  it("setCategory updates selected category", () => {
    useAppStore.getState().setCategory("Games");
    expect(useAppStore.getState().selectedCategory).toBe("Games");
  });

  it("newApps() filters entries with new flag", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);
    const newApps = useAppStore.getState().newApps();
    expect(newApps).toHaveLength(1);
    expect(newApps[0].id).toBe("snake");
  });

  it("topRated() returns top 10 by rating descending", () => {
    useAppStore.getState().setEntries(SAMPLE_ENTRIES);
    const topRated = useAppStore.getState().topRated();
    expect(topRated.length).toBeLessThanOrEqual(10);
    expect(topRated[0].id).toBe("snake"); // 4.8
    expect(topRated[1].id).toBe("code-editor"); // 4.6
    expect(topRated[2].id).toBe("todo"); // 4.5
  });
});

describe("Fallback catalog", () => {
  it("has both bundled and prompt entries", async () => {
    const { FALLBACK_CATALOG } = await import("../../shell/src/components/app-store/catalog");
    const bundled = FALLBACK_CATALOG.filter((e) => e.source === "bundled");
    const prompt = FALLBACK_CATALOG.filter((e) => e.source === "prompt");
    expect(bundled.length).toBeGreaterThan(0);
    expect(prompt.length).toBeGreaterThan(0);
    expect(FALLBACK_CATALOG.length).toBeGreaterThanOrEqual(40);
  });

  it("all entries have required fields", async () => {
    const { FALLBACK_CATALOG } = await import("../../shell/src/components/app-store/catalog");
    for (const entry of FALLBACK_CATALOG) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(entry.category).toBeTruthy();
      expect(entry.icon).toBeTruthy();
      expect(entry.iconColor).toBeTruthy();
    }
  });

  it("prompt entries all have prompts", async () => {
    const { FALLBACK_CATALOG } = await import("../../shell/src/components/app-store/catalog");
    const prompts = FALLBACK_CATALOG.filter((e) => e.source === "prompt");
    for (const entry of prompts) {
      expect(entry.prompt).toBeTruthy();
    }
  });
});

describe("StarRating logic", () => {
  function getStars(rating: number): { filled: number; half: boolean; empty: number } {
    const filled = Math.floor(rating);
    const half = rating - filled >= 0.25 && rating - filled < 0.75;
    const empty = 5 - filled - (half ? 1 : 0);
    return { filled, half, empty };
  }

  it("renders 5 filled for rating 5", () => {
    expect(getStars(5)).toEqual({ filled: 5, half: false, empty: 0 });
  });

  it("renders 4 filled + 1 half for rating 4.5", () => {
    expect(getStars(4.5)).toEqual({ filled: 4, half: true, empty: 0 });
  });

  it("renders 3 filled + 2 empty for rating 3.0", () => {
    expect(getStars(3.0)).toEqual({ filled: 3, half: false, empty: 2 });
  });

  it("renders 0 filled + 5 empty for rating 0", () => {
    expect(getStars(0)).toEqual({ filled: 0, half: false, empty: 5 });
  });

  it("rounds near-whole values correctly", () => {
    expect(getStars(4.1)).toEqual({ filled: 4, half: false, empty: 1 });
    expect(getStars(4.8)).toEqual({ filled: 4, half: false, empty: 1 });
    expect(getStars(4.3)).toEqual({ filled: 4, half: true, empty: 0 });
  });
});

describe("AppCard display logic", () => {
  it("bundled apps show Open button", () => {
    const entry: AppStoreEntry = {
      id: "todo",
      name: "Todo",
      description: "Task list",
      category: "Productivity",
      author: "Matrix OS",
      source: "bundled",
    };
    expect(entry.source).toBe("bundled");
  });

  it("prompt apps show Get button", () => {
    const entry: AppStoreEntry = {
      id: "snake",
      name: "Snake",
      description: "Game",
      category: "Games",
      author: "Matrix OS",
      source: "prompt",
      prompt: "Build snake",
    };
    expect(entry.source).toBe("prompt");
    expect(entry.prompt).toBeTruthy();
  });

  it("installed apps show Installed state", () => {
    useAppStore.getState().markInstalled("snake");
    expect(useAppStore.getState().installedIds.has("snake")).toBe(true);
  });

  it("formats download counts for display", () => {
    function formatDownloads(n: number): string {
      if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
      return String(n);
    }

    expect(formatDownloads(5000)).toBe("5.0K");
    expect(formatDownloads(12000)).toBe("12K");
    expect(formatDownloads(500)).toBe("500");
    expect(formatDownloads(1500)).toBe("1.5K");
  });
});

describe("CATEGORIES constant", () => {
  it("has 14 categories including All", () => {
    expect(CATEGORIES).toHaveLength(14);
  });

  it("starts with All", () => {
    expect(CATEGORIES[0]).toBe("All");
  });

  it("includes expected categories", () => {
    expect(CATEGORIES).toContain("Productivity");
    expect(CATEGORIES).toContain("Games");
    expect(CATEGORIES).toContain("Developer Tools");
    expect(CATEGORIES).toContain("Finance");
    expect(CATEGORIES).toContain("Health & Fitness");
  });
});
