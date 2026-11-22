import { describe, expect, it } from "vitest";
import { MatrixRoomIdSchema } from "@matrix-os/contracts/messaging-bridge";

describe("messaging bridge Matrix ids", () => {
  it("accepts the server-less room ids the live homeserver issues, and the classic form", () => {
    // Seen live on the shared bridge host (spike-results.md): `!<opaque>` with no `:server`.
    expect(MatrixRoomIdSchema.safeParse("!Abc123_-xYz.=/+").success).toBe(true);
    expect(MatrixRoomIdSchema.safeParse("!portal:bridge.example.test").success).toBe(true);
    expect(MatrixRoomIdSchema.safeParse("!portal:bridge.example.test:8448").success).toBe(true);
  });

  it("rejects values that are not room ids", () => {
    for (const value of ["", "!", "portal:bridge.example.test", "!room id", "!room:bad host", `!${"a".repeat(255)}`]) {
      expect(MatrixRoomIdSchema.safeParse(value).success, value).toBe(false);
    }
  });
});
