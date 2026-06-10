import { afterEach, describe, expect, it, vi } from "vitest";

import { buildShellMetadata } from "@/lib/shell-metadata";

describe("shell metadata", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does not fetch localhost identity metadata when no gateway URL is configured", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;

    const metadata = await buildShellMetadata(undefined);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadata.title).toBe("Matrix OS");
    expect(metadata.description).toBe("Your AI operating system");
  });

  it("uses configured gateway identity metadata when available", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ handle: "alice", displayName: "Alice" }),
    });
    global.fetch = fetchMock as typeof fetch;

    const metadata = await buildShellMetadata("http://gateway.test");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://gateway.test/api/identity",
      expect.objectContaining({
        next: { revalidate: 60 },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(metadata.title).toBe("Matrix OS — @alice");
    expect(metadata.description).toBe("Alice's AI operating system");
  });
});
