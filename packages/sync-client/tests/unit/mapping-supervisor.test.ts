import { describe, expect, it, vi } from "vitest";
import type { SyncMappingConfig } from "@matrix-os/contracts/sync";
import {
  dispatchMappingEvent,
  openMappingSessions,
  startMappingSessions,
  stopMappingSessions,
} from "../../src/daemon/mapping-supervisor.js";

function config(): SyncMappingConfig {
  return {
    schemaVersion: 2,
    revision: 3,
    profile: "cloud",
    ownerId: "user_test",
    runtimeSlot: "primary",
    deviceId: "peer-test",
    enabled: true,
    mappings: ["", "projects/one", "projects/two"].map((remotePrefix, index) => ({
      id: `${index + 1}1111111-1111-4111-8111-111111111111`,
      label: remotePrefix || "Matrix Home",
      localRoot: `/tmp/mapping-${index}`,
      remotePrefix,
      direction: "two_way" as const,
      enabled: true,
      propagateDeletes: false,
      excludes: index === 0 ? ["projects/one/", "projects/two/"] : [],
    })),
  };
}

describe("mapping supervisor", () => {
  it("opens full-home and custom mappings with isolated state files and one shared revision", async () => {
    const seen: Array<{ stateFile: string; revision: object; mappingId: string }> = [];
    const revision = { value: 9 };
    const sessions = await openMappingSessions({
      configDir: "/tmp/config",
      config: config(),
      gatewayClient: { gatewayUrl: "https://gateway.example", token: "token" },
      revision,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueue: async (fn) => fn(),
      onAuthRejected: vi.fn(),
      open: async (options) => {
        seen.push({
          stateFile: options.stateFile,
          revision: options.revision,
          mappingId: options.mapping.id,
        });
        return {
          mapping: options.mapping,
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          applyRemoteEvent: vi.fn().mockResolvedValue(true),
        };
      },
    });

    expect(sessions).toHaveLength(3);
    expect(new Set(seen.map((entry) => entry.stateFile)).size).toBe(3);
    expect(seen.every((entry) => entry.revision === revision)).toBe(true);
    expect(seen.map((entry) => entry.mappingId)).toEqual(config().mappings.map((mapping) => mapping.id));
  });

  it("starts, dispatches, and stops every mapping without redirecting another", async () => {
    const sessions = [0, 1, 2].map((index) => ({
      mapping: { id: String(index) },
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      applyRemoteEvent: vi.fn().mockResolvedValue(index !== 1),
    }));
    const event = {
      type: "sync:change" as const,
      peerId: "peer-two",
      files: [{
        path: "projects/one/readme.md",
        hash: `sha256:${"a".repeat(64)}`,
        size: 1,
        action: "update" as const,
      }],
    };

    await startMappingSessions(sessions, {});
    await expect(dispatchMappingEvent(sessions, event)).resolves.toBe(false);
    await stopMappingSessions(sessions);

    for (const session of sessions) {
      expect(session.start).toHaveBeenCalledOnce();
      expect(session.applyRemoteEvent).toHaveBeenCalledWith(event);
      expect(session.stop).toHaveBeenCalledOnce();
    }
  });
});
