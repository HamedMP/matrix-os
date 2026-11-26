import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "../../packages/ui/src/random-uuid";

// A self-hosted Matrix can be served over tailnet-only HTTP. Browsers hide
// crypto.randomUUID outside secure contexts, which used to crash Chat during
// render and break Terminal launches; getRandomValues stays available there.
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUUID", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the native generator in a secure context", () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
    expect(randomUUID()).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("builds an RFC 4122 v4 id from getRandomValues over plain HTTP", () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    const ids = new Set(Array.from({ length: 200 }, () => randomUUID()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(V4);
  });

  it("sets the version and variant bits whatever the random bytes are", () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(0xff) });
    expect(randomUUID()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(0) });
    expect(randomUUID()).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("refuses to invent an id without a secure random source", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => randomUUID()).toThrow(/random/i);
  });
});
