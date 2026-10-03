import { describe, expect, it } from "vitest";
import { CollaborationEndpointOriginSchema } from "../../packages/ui/src/collaboration/direct-client.js";

describe("collaboration endpoint origin", () => {
  it.each([
    "https://home.example",
    "https://relay.matrix-os.com:8443",
    "http://localhost:3000",
    // URL validation permits these; requireOrigin later enforces an HTTP(S) origin.
    "https://home.example/path",
    "ftp://home.example",
    "mailto:a@example.com",
  ])("accepts a URL origin: %s", (origin) => {
    expect(CollaborationEndpointOriginSchema.safeParse(origin).success).toBe(true);
  });

  it.each(["", "not-a-url", "https://", "https://bad host", null, 42])("rejects an invalid URL origin: %s", (origin) => {
    expect(CollaborationEndpointOriginSchema.safeParse(origin).success).toBe(false);
  });
});
