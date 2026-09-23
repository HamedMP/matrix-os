import { describe, expect, it } from "vitest";
import { createHmac } from 'node:crypto';
import {
  buildPlatformRuntimeVerificationToken,
  buildPlatformSpeechRuntimeVerificationToken,
  buildPlatformSyncVerificationToken,
} from "../../packages/platform/src/platform-token.js";

const identity = { handle: "alice", machineId: "machine_123", runtimeSlot: "primary" };
const secret = "platform-secret-for-tests-123456789";

describe("per-machine runtime token epochs", () => {
  for (const [name, derive] of [
    ["funded AI", buildPlatformRuntimeVerificationToken],
    ["sync", buildPlatformSyncVerificationToken],
    ["speech", buildPlatformSpeechRuntimeVerificationToken],
  ] as const) {
    it(`invalidates only the selected ${name} token when its epoch advances`, () => {
      const original = derive(identity, secret);
      expect(derive(identity, secret, 1)).toBe(original);
      const kind = name === 'funded AI' ? 'matrix-funded-ai-runtime' : name === 'sync' ? 'matrix-sync-runtime' : 'matrix-platform-speech-runtime';
      const legacy = createHmac('sha256', secret)
        .update(JSON.stringify([kind, 1, identity.handle, identity.machineId, identity.runtimeSlot]))
        .digest('hex');
      expect(original).toBe(legacy);
      expect(derive(identity, secret, 2)).not.toBe(original);
      expect(derive({ ...identity, machineId: "another_machine" }, secret, 1))
        .toBe(derive({ ...identity, machineId: "another_machine" }, secret));
    });

    it(`rejects invalid ${name} token epochs`, () => {
      expect(() => derive(identity, secret, 0)).toThrow();
      expect(() => derive(identity, secret, 1.5)).toThrow();
    });
  }
});
