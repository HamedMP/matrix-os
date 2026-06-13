// Installed Matrix OS apps (GET /api/apps). Loaded lazily and shared by the
// Apps launcher and the command palette so both list the same set.
import { create } from "zustand";
import { AppError, type AppErrorCategory } from "../../../shared/app-error";
import type { ApiClient } from "../lib/api";

export interface MatrixApp {
  slug: string;
  name: string;
  category?: string;
}

export function parseApps(value: unknown): MatrixApp[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { apps?: unknown }).apps)
      ? (value as { apps: unknown[] }).apps
      : [];
  const apps: MatrixApp[] = [];
  for (const raw of list.slice(0, 200)) {
    if (raw && typeof raw === "object" && typeof (raw as MatrixApp).slug === "string") {
      const app = raw as MatrixApp;
      apps.push({ slug: app.slug, name: app.name ?? app.slug, category: app.category });
    }
  }
  return apps;
}

interface AppsState {
  apps: MatrixApp[];
  loaded: boolean;
  loading: boolean;
  error: AppErrorCategory | null;
  load(api: ApiClient, force?: boolean): Promise<void>;
}

export const useApps = create<AppsState>()((set, get) => ({
  apps: [],
  loaded: false,
  loading: false,
  error: null,

  load: async (api, force = false) => {
    if (get().loading) return;
    if (get().loaded && !force) return;
    set({ loading: true });
    try {
      const res = await api.get<unknown>("/api/apps");
      set({ apps: parseApps(res), loaded: true, loading: false, error: null });
    } catch (err: unknown) {
      set({ loading: false, loaded: true, error: err instanceof AppError ? err.category : "server" });
    }
  },
}));
