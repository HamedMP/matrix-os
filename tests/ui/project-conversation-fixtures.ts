import type { ChatNavigationRecord } from "../../packages/ui/src/chat-navigation/projection";

type Overrides = {
  chat?: Partial<ChatNavigationRecord["chat"]>;
  activeRun?: ChatNavigationRecord["activeRun"];
  driverKind?: NonNullable<ChatNavigationRecord["providerBinding"]>["driverKind"];
};

export function chatRecord(id: string, overrides: Overrides = {}): ChatNavigationRecord {
  return {
    chat: {
      id, title: `Chat ${id}`, lifecycle: "active", attention: "none", revision: 1, messageCount: 2,
      createdAt: "2026-11-10T10:00:00.000Z", updatedAt: "2026-11-10T10:00:00.000Z", activityAt: "2026-11-10T10:00:00.000Z",
      ...overrides.chat,
    },
    projectId: "matrix-os",
    ...(overrides.activeRun ? { activeRun: overrides.activeRun } : {}),
    ...(overrides.driverKind ? { providerBinding: { driverKind: overrides.driverKind } } : {}),
  };
}

export const run = (status: NonNullable<ChatNavigationRecord["activeRun"]>["status"]) => ({ runId: "run_1", turnId: "turn_1", status }) as NonNullable<ChatNavigationRecord["activeRun"]>;
