import { z } from "zod/v4";
import { EMPTY_BOARD_FILTER, type BoardFilter } from "./board-model.js";
import { TASK_LIMITS, TASK_PRIORITIES, TASK_STATUSES, type ActorRef } from "./types.js";

/** Per-project, per-surface board view memory: layout and filters (spec 2699 section 8). */
export interface BoardPreferences {
  layout: "board" | "list";
  filter: BoardFilter;
}

export const DEFAULT_BOARD_PREFERENCES: BoardPreferences = { layout: "board", filter: EMPTY_BOARD_FILTER };

const ACTOR_PATTERN = /^(user|agent|system):\S{1,190}$/;
const ACTOR = z.custom<ActorRef>((value) => typeof value === "string" && ACTOR_PATTERN.test(value));
const PreferencesSchema = z.object({
  layout: z.enum(["board", "list"]),
  filter: z.object({
    statuses: z.array(z.enum(TASK_STATUSES)).max(TASK_STATUSES.length),
    priorities: z.array(z.enum(TASK_PRIORITIES)).max(TASK_PRIORITIES.length),
    labels: z.array(z.string().min(1).max(TASK_LIMITS.label)).max(50),
    assignees: z.array(z.union([z.literal("unassigned"), ACTOR])).max(100),
    search: z.string().max(200),
    showCanceled: z.boolean(),
    showArchived: z.boolean(),
  }),
});

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function boardPreferencesKey(surface: string, projectId: string): string {
  return `matrix:project-board:v1:${surface}:${projectId}`;
}

/** Stored preferences, or the defaults when nothing valid is stored. */
export function readBoardPreferences(storage: PreferenceStorage | undefined, key: string): BoardPreferences {
  if (!storage) return DEFAULT_BOARD_PREFERENCES;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch (error: unknown) {
    console.warn("[project-board] preferences could not be read", error instanceof Error ? error.name : typeof error);
    return DEFAULT_BOARD_PREFERENCES;
  }
  if (!raw || raw.length > 20_000) return DEFAULT_BOARD_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return DEFAULT_BOARD_PREFERENCES;
  }
  const result = PreferencesSchema.safeParse(parsed);
  return result.success ? result.data : DEFAULT_BOARD_PREFERENCES;
}

export function writeBoardPreferences(storage: PreferenceStorage | undefined, key: string, preferences: BoardPreferences): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(preferences));
  } catch (error: unknown) {
    console.warn("[project-board] preferences could not be saved", error instanceof Error ? error.name : typeof error);
  }
}
