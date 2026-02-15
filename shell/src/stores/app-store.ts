import { create } from "zustand";
import { FALLBACK_CATALOG } from "@/components/app-store/catalog";

export interface AppStoreEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  author: string;
  source: "bundled" | "url" | "prompt" | "community";
  prompt?: string;
  url?: string;
  longDescription?: string;
  icon?: string;
  iconColor?: string;
  rating?: number;
  ratingCount?: number;
  downloads?: number;
  version?: string;
  tags?: string[];
  featured?: boolean;
  featuredTagline?: string;
  new?: boolean;
}

export const CATEGORIES = [
  "All",
  "Productivity",
  "Utilities",
  "Developer Tools",
  "Games",
  "Education",
  "Finance",
  "Health & Fitness",
  "Social",
  "Music",
  "Photo & Video",
  "News",
  "Entertainment",
  "Lifestyle",
] as const;

export type Category = (typeof CATEGORIES)[number];

interface AppStoreState {
  entries: AppStoreEntry[];
  search: string;
  selectedCategory: Category;
  selectedApp: AppStoreEntry | null;
  installedIds: Set<string>;

  setEntries: (entries: AppStoreEntry[]) => void;
  setSearch: (search: string) => void;
  setCategory: (category: Category) => void;
  selectApp: (app: AppStoreEntry | null) => void;
  markInstalled: (id: string) => void;

  featured: () => AppStoreEntry[];
  bundled: () => AppStoreEntry[];
  promptLibrary: () => AppStoreEntry[];
  byCategory: (category: string) => AppStoreEntry[];
  searchResults: () => AppStoreEntry[];
  newApps: () => AppStoreEntry[];
  topRated: () => AppStoreEntry[];
}

function matchCategory(entry: AppStoreEntry, category: string): boolean {
  return entry.category.toLowerCase() === category.toLowerCase();
}

export const useAppStore = create<AppStoreState>()((set, get) => ({
  entries: FALLBACK_CATALOG,
  search: "",
  selectedCategory: "All",
  selectedApp: null,
  installedIds: new Set(),

  setEntries: (entries) => set({ entries }),
  setSearch: (search) => set({ search }),
  setCategory: (selectedCategory) => set({ selectedCategory }),
  selectApp: (selectedApp) => set({ selectedApp }),
  markInstalled: (id) =>
    set((state) => {
      const next = new Set(state.installedIds);
      next.add(id);
      return { installedIds: next };
    }),

  featured: () => get().entries.filter((e) => e.featured),

  bundled: () => get().entries.filter((e) => e.source === "bundled"),

  promptLibrary: () => get().entries.filter((e) => e.source === "prompt"),

  byCategory: (category) => {
    if (category === "All") return get().entries;
    return get().entries.filter((e) => matchCategory(e, category));
  },

  searchResults: () => {
    const { entries, search, selectedCategory } = get();
    let result = selectedCategory === "All"
      ? entries
      : entries.filter((e) => matchCategory(e, selectedCategory));

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          (e.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      );
    }
    return result;
  },

  newApps: () => get().entries.filter((e) => e.new),

  topRated: () =>
    [...get().entries]
      .filter((e) => e.rating !== undefined)
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, 10),
}));
