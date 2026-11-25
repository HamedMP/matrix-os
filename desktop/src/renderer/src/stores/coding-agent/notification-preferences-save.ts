import type { CodingAgentNotificationPreferences, CodingAgentNotificationPreferencesUpdate } from "@matrix-os/contracts";

interface PreferenceState {
  notificationPreferences: CodingAgentNotificationPreferences | null;
  notificationPreferencesStatus: "idle" | "loading" | "ready" | "saving" | "error";
  notificationPreferencesError: string | null;
}

/** At most four intended switch edits, serialized without copying a stale full snapshot. */
export function createNotificationPreferenceSaveQueue(options: {
  getState(): PreferenceState;
  setState(patch: Partial<PreferenceState>): void;
  save(request: CodingAgentNotificationPreferencesUpdate): Promise<CodingAgentNotificationPreferences>;
}) {
  let pending: CodingAgentNotificationPreferencesUpdate["attentionPush"] = {};
  let active: Promise<void> | null = null;
  let epoch = 0;

  async function run(): Promise<void> {
    while (Object.keys(pending).length > 0) {
      const patch = pending;
      pending = {};
      const generation = epoch;
      const previous = options.getState().notificationPreferences;
      options.setState({ notificationPreferencesStatus: "saving", notificationPreferencesError: null });
      try {
        const preferences = await options.save({ attentionPush: patch });
        if (generation !== epoch) continue;
        options.setState({ notificationPreferencesStatus: "ready", notificationPreferences: preferences, notificationPreferencesError: null });
      } catch (error: unknown) {
        if (generation !== epoch) continue;
        console.warn("[coding-agents] notification preferences update failed", error instanceof Error ? error.name : "UnknownError");
        pending = {};
        options.setState({ notificationPreferencesStatus: "error", notificationPreferences: previous,
          notificationPreferencesError: "Notification settings could not be saved. Try again." });
        return;
      }
    }
  }
  function flush(): Promise<void> {
    if (active) return active;
    active = Promise.resolve().then(run).finally(() => {
      active = null;
      if (Object.keys(pending).length > 0) return flush();
    });
    return active;
  }
  return {
    enqueue(patch: CodingAgentNotificationPreferencesUpdate["attentionPush"]): Promise<void> {
      pending = { ...pending, ...patch };
      return flush();
    },
    reset(): void { epoch += 1; pending = {}; },
  };
}
