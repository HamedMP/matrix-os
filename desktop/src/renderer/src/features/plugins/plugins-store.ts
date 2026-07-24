// Plugins hub store: installed skills from the gateway route
// GET /api/settings/skills. Bounded, serializable state only. All user-facing
// error strings go through the shared display boundary — upstream text never
// renders. Mirrors the integrations store's capability gating: a 404 means
// the runtime predates the route, so the section goes "unavailable" instead
// of "error".
import { create } from "zustand";
import { AppError, categoryMessage } from "../../../../shared/app-error";
import type { ApiClient } from "../../lib/api";
import { toUserMessage } from "../../lib/errors";
import { useConnection } from "../../stores/connection";
import { parseSkills, type SkillInfo } from "./types";

const SKILLS_PATH = "/api/settings/skills";

export type SkillsStatus = "idle" | "loading" | "ready" | "unavailable" | "error";

interface PluginsState {
  skills: SkillInfo[];
  skillsStatus: SkillsStatus;
  // Generic, display-safe copy (categoryMessage/toUserMessage output only).
  skillsError: string | null;
  // Loads the installed skills list. Omit the argument to use the active
  // runtime client.
  refreshSkills: (apiOverride?: ApiClient | null) => Promise<void>;
}

function resolveApi(apiOverride: ApiClient | null | undefined): ApiClient | null {
  if (apiOverride !== undefined) return apiOverride;
  return useConnection.getState().api;
}

export const usePlugins = create<PluginsState>()((set) => ({
  skills: [],
  skillsStatus: "idle",
  skillsError: null,

  refreshSkills: async (apiOverride) => {
    const api = resolveApi(apiOverride);
    if (!api) {
      set({
        skillsStatus: "error",
        skillsError: categoryMessage("misconfigured"),
        skills: [],
      });
      return;
    }
    set({ skillsStatus: "loading", skillsError: null });
    try {
      const raw = await api.get<unknown>(SKILLS_PATH);
      set({ skillsStatus: "ready", skills: parseSkills(raw), skillsError: null });
    } catch (err: unknown) {
      if (err instanceof AppError && err.category === "notFound") {
        set({ skillsStatus: "unavailable", skills: [], skillsError: null });
        return;
      }
      console.warn(
        "[plugins] skills refresh failed:",
        err instanceof Error ? err.message : String(err),
      );
      set({ skillsStatus: "error", skillsError: toUserMessage(err) });
    }
  },
}));

// Alias for non-React callers (orchestrator wiring, tests): the same store,
// callable as usePlugins would be and exposing getState/setState.
export const pluginsStore = usePlugins;
