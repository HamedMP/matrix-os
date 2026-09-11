import { describe, expect, it } from "vitest";
import { CanonicalProviderDriverKindSchema } from "@matrix-os/contracts";

describe("canonical Chat provider drivers", () => {
  it("recognizes the Matrix Agent SDK kernel as an execution driver", () => {
    expect(CanonicalProviderDriverKindSchema.parse("kernel")).toBe("kernel");
  });
});
