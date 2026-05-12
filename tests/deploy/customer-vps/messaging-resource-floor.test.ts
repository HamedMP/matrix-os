import { describe, expect, it } from "vitest";
import {
  DEFAULT_MESSAGING_RESOURCE_FLOOR,
  SYNAPSE_MESSAGING_RESOURCE_FLOOR,
  meetsMessagingResourceFloor,
} from "./helpers/messaging-resource-floor.js";

describe("messaging resource floor", () => {
  it("accepts the default Telegram plus WhatsApp floor", () => {
    expect(meetsMessagingResourceFloor({
      vcpu: 2,
      memoryGiB: 4,
      diskGiB: 40,
    })).toBe(true);
  });

  it("rejects customer VPSes below the messaging floor", () => {
    expect(meetsMessagingResourceFloor({
      vcpu: 1,
      memoryGiB: 2,
      diskGiB: 20,
    })).toBe(false);
  });

  it("requires the higher Synapse recommendation when selected", () => {
    expect(meetsMessagingResourceFloor({
      vcpu: 2,
      memoryGiB: 4,
      diskGiB: 40,
    }, SYNAPSE_MESSAGING_RESOURCE_FLOOR)).toBe(false);

    expect(DEFAULT_MESSAGING_RESOURCE_FLOOR.memoryGiB).toBe(4);
  });
});
