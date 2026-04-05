import { create } from "zustand";
import { FALLBACK_CATALOG } from "@/components/app-store/catalog";
import { getGatewayUrl } from "@/lib/gateway";

export interface AppStoreEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  author: string;
  source: "bundled" | "url" | "prompt" | "community" | "registry" | "gallery";
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
  slug?: string;
  authorId?: string;
  forksCount?: number;
  isPublic?: boolean;
  // Gallery-specific fields
  listingId?: string;
  permissions?: string[];
  integrations?: { required?: string[]; optional?: string[] };
  auditStatus?: "passed" | "pending" | "failed";
  visibility?: string;
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

interface Installation {
  id: string;
  listing_id: string;
  version_id: string;
  status: string;
}

interface InstallationUpdate {
  installationId: string;
  listingId: string;
  listingSlug: string;
  listingName: string;
  installedVersion: string;
  currentVersion: string;
  hasUpdate: boolean;
}

interface AppStoreState {
  entries: AppStoreEntry[];
  search: string;
  selectedCategory: Category;
  selectedApp: AppStoreEntry | null;
  installedIds: Set<string>;
  installations: Map<string, Installation>;
  updatesAvailable: Map<string, InstallationUpdate>;
  loading: boolean;

  setEntries: (entries: AppStoreEntry[]) => void;
  setSearch: (search: string) => void;
  setCategory: (category: Category) => void;
  selectApp: (app: AppStoreEntry | null) => void;
  markInstalled: (id: string) => void;
  setLoading: (loading: boolean) => void;

  fetchGalleryApps: () => Promise<void>;
  fetchInstallations: () => Promise<void>;
  fetchUpdates: () => Promise<void>;

  featured: () => AppStoreEntry[];
  bundled: () => AppStoreEntry[];
  promptLibrary: () => AppStoreEntry[];
  galleryApps: () => AppStoreEntry[];
  byCategory: (category: string) => AppStoreEntry[];
  searchResults: () => AppStoreEntry[];
  newApps: () => AppStoreEntry[];
  topRated: () => AppStoreEntry[];
  appsWithUpdates: () => InstallationUpdate[];
}

function matchCategory(entry: AppStoreEntry, category: string): boolean {
  return entry.category.toLowerCase() === category.toLowerCase();
}

function mapListingToEntry(listing: any): AppStoreEntry {
  return {
    id: listing.id,
    name: listing.name,
    description: listing.description ?? "",
    category: listing.category ?? "utility",
    author: listing.author_id ?? "unknown",
    source: "gallery",
    slug: listing.slug,
    authorId: listing.author_id,
    icon: listing.icon_url ? undefined : listing.name.charAt(0),
    rating: listing.avg_rating ? Number(listing.avg_rating) : undefined,
    ratingCount: listing.ratings_count,
    downloads: listing.installs_count,
    tags: listing.tags ?? [],
    version: listing.version,
    isPublic: listing.visibility === "public",
    listingId: listing.id,
    permissions: listing.permissions,
    integrations: listing.integrations,
    visibility: listing.visibility,
    longDescription: listing.long_description,
  };
}

export const useAppStore = create<AppStoreState>()((set, get) => ({
  entries: FALLBACK_CATALOG,
  search: "",
  selectedCategory: "All",
  selectedApp: null,
  installedIds: new Set(),
  installations: new Map(),
  updatesAvailable: new Map(),
  loading: false,

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
  setLoading: (loading) => set({ loading }),

  fetchGalleryApps: async () => {
    try {
      set({ loading: true });
      const gatewayUrl = getGatewayUrl();
      const res = await fetch(`${gatewayUrl}/api/gallery/apps?limit=100&sort=popular`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return;
      const data = await res.json();
      const galleryEntries = (data.apps ?? []).map(mapListingToEntry);

      // Merge gallery listings with fallback catalog
      const merged = [...FALLBACK_CATALOG];
      for (const entry of galleryEntries) {
        if (!merged.some((e) => e.id === entry.id || e.slug === entry.slug)) {
          merged.push(entry);
        }
      }
      set({ entries: merged });
    } catch {
      // Keep fallback catalog on error
    } finally {
      set({ loading: false });
    }
  },

  fetchInstallations: async () => {
    try {
      const gatewayUrl = getGatewayUrl();
      const res = await fetch(`${gatewayUrl}/api/gallery/installations`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return;
      const data = await res.json();
      const installs = new Map<string, Installation>();
      const ids = new Set<string>();
      for (const inst of data.installations ?? []) {
        installs.set(inst.listing_id, inst);
        ids.add(inst.listing_id);
      }
      set({ installations: installs, installedIds: ids });
    } catch {
      // ignore
    }
  },

  fetchUpdates: async () => {
    try {
      const gatewayUrl = getGatewayUrl();
      const res = await fetch(`${gatewayUrl}/api/gallery/installations/updates`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return;
      const data = await res.json();
      const updates = new Map<string, InstallationUpdate>();
      for (const inst of data.installations ?? []) {
        if (inst.hasUpdate) {
          updates.set(inst.listingId, inst);
        }
      }
      set({ updatesAvailable: updates });
    } catch {
      // ignore
    }
  },

  featured: () => get().entries.filter((e) => e.featured),

  bundled: () => get().entries.filter((e) => e.source === "bundled"),

  promptLibrary: () => get().entries.filter((e) => e.source === "prompt"),

  galleryApps: () => get().entries.filter((e) => e.source === "gallery"),

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

  appsWithUpdates: () => Array.from(get().updatesAvailable.values()),
}));
