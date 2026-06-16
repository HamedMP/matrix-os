import { describe, expect, it } from "vitest";
import { parseChannelStatusResponse } from "@desktop/renderer/src/features/settings/sections/ChannelsSection";

describe("parseChannelStatusResponse", () => {
  it("accepts array and record channel status payloads", () => {
    expect(parseChannelStatusResponse([
      { name: "telegram", connected: true },
      { name: "discord", connected: false },
      { name: 123, connected: true },
    ])).toEqual([
      { name: "telegram", connected: true },
      { name: "discord", connected: false },
    ]);

    expect(parseChannelStatusResponse({
      slack: true,
      matrix: { connected: false },
    })).toEqual([
      { name: "slack", connected: true },
      { name: "matrix", connected: false },
    ]);
  });
});
