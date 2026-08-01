import { describe, expect, it, vi } from "vitest";
import {
  MAX_TERMINAL_SESSION_METADATA_BYTES,
  MAX_TERMINAL_SESSION_METADATA_ROWS,
  TERMINAL_METADATA_FETCH_TIMEOUT_MS,
  initialTerminalProtocolState,
  resolveTerminalGatewayCompatibility,
  transitionTerminalProtocolState,
} from "../../shell/src/components/terminal/terminal-gateway-compat.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function probeOptions(responses: Response[]) {
  const fetchImpl = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("unexpected metadata request");
    return response;
  });
  return {
    options: {
      gatewayUrl: "https://gateway.example",
      sessionId: "main",
      signal: new AbortController().signal,
      fetchImpl,
      wait: vi.fn(async () => {}),
    },
    fetchImpl,
  };
}

describe("terminal gateway compatibility negotiation", () => {
  it("models probing, canonical, compatibility, legacy, error, and session reset explicitly", () => {
    const probing = initialTerminalProtocolState("main", true);
    expect(probing).toEqual({ mode: "probing", sessionId: "main", canonicalSize: null });

    expect(transitionTerminalProtocolState(probing, {
      type: "attached-canonical",
      size: { cols: 140, rows: 40 },
    })).toEqual({
      mode: "canonical",
      sessionId: "main",
      canonicalSize: { cols: 140, rows: 40 },
    });
    expect(transitionTerminalProtocolState(probing, {
      type: "metadata-canonical",
      size: { cols: 132, rows: 36 },
    }).mode).toBe("canonical-compatibility");
    expect(transitionTerminalProtocolState(probing, { type: "metadata-legacy" }).mode)
      .toBe("legacy-compatibility");
    expect(transitionTerminalProtocolState(probing, { type: "metadata-error" }).mode)
      .toBe("incompatible");

    const reset = transitionTerminalProtocolState(
      { mode: "canonical-compatibility", sessionId: "main", canonicalSize: { cols: 140, rows: 40 } },
      { type: "session-change", sessionId: "other", canonical: true },
    );
    expect(reset).toEqual({ mode: "probing", sessionId: "other", canonicalSize: null });
  });

  it("waits through the sizing debounce and selects the latest stable hard-client size", async () => {
    const { options, fetchImpl } = probeOptions([
      jsonResponse({ sessions: [{ name: "main", canonicalSize: { cols: 200, rows: 50 } }] }),
      jsonResponse({ sessions: [{ name: "main", canonicalSize: { cols: 140, rows: 40 } }] }),
      jsonResponse({ sessions: [{ name: "main", canonicalSize: { cols: 140, rows: 40 } }] }),
    ]);

    await expect(resolveTerminalGatewayCompatibility(options)).resolves.toEqual({
      kind: "canonical-compatibility",
      size: { cols: 140, rows: 40 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gateway.example/api/terminal/sessions",
      expect.objectContaining({ credentials: "same-origin", signal: expect.any(AbortSignal) }),
    );
  });

  it("accepts the specification default only when the sizing-aware gateway persists it", async () => {
    const { options } = probeOptions([
      jsonResponse({ sessions: [{ name: "main" }] }),
      jsonResponse({ sessions: [{ name: "main", canonicalSize: { cols: 200, rows: 50 } }] }),
      jsonResponse({ sessions: [{ name: "main", canonicalSize: { cols: 200, rows: 50 } }] }),
    ]);

    await expect(resolveTerminalGatewayCompatibility(options)).resolves.toEqual({
      kind: "canonical-compatibility",
      size: { cols: 200, rows: 50 },
    });
  });

  it("classifies a gateway as legacy only after every bounded probe lacks canonical sizing", async () => {
    const { options, fetchImpl } = probeOptions([
      jsonResponse({ sessions: [{ name: "main" }] }),
      jsonResponse({ sessions: [{ name: "main" }] }),
      jsonResponse({ sessions: [{ name: "main" }] }),
    ]);

    await expect(resolveTerminalGatewayCompatibility(options)).resolves.toEqual({
      kind: "legacy-compatibility",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ cols: 0, rows: 40 }],
    [{ cols: 501, rows: 40 }],
    [{ cols: 140.5, rows: 40 }],
    [{ cols: 140, rows: 0 }],
    [{ cols: 140, rows: 201 }],
    [{ cols: 140, rows: 40.5 }],
  ])("rejects invalid canonical bounds without falling back silently: %j", async (canonicalSize) => {
    const { options } = probeOptions([
      jsonResponse({ sessions: [{ name: "main", canonicalSize }] }),
    ]);

    await expect(resolveTerminalGatewayCompatibility(options)).resolves.toEqual({
      kind: "incompatible",
    });
  });

  it.each([
    ["non-2xx", [jsonResponse({ error: "database path leaked" }, 503)]],
    ["malformed JSON", [new Response("{broken", { status: 200 })]],
    ["unknown session", [jsonResponse({ sessions: [{ name: "other" }] })]],
    ["malformed payload", [jsonResponse({ sessions: "not-an-array" })]],
  ])("returns one generic incompatible result for %s metadata", async (_label, responses) => {
    const { options } = probeOptions(responses);
    await expect(resolveTerminalGatewayCompatibility(options)).resolves.toEqual({
      kind: "incompatible",
    });
  });

  it("aborts pending retry work without issuing another request", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => jsonResponse({ sessions: [{ name: "main" }] }));
    const wait = vi.fn(async (_delay: number, signal: AbortSignal) => {
      controller.abort();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    });

    await expect(resolveTerminalGatewayCompatibility({
      gatewayUrl: "https://gateway.example",
      sessionId: "main",
      signal: controller.signal,
      fetchImpl,
      wait,
    })).resolves.toEqual({ kind: "cancelled" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("times out a metadata request and clears its bounded timer", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        })
      ));
      const result = resolveTerminalGatewayCompatibility({
        gatewayUrl: "https://gateway.example",
        sessionId: "main",
        signal: new AbortController().signal,
        fetchImpl,
      });

      await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_FETCH_TIMEOUT_MS + 1);
      await expect(result).resolves.toEqual({ kind: "incompatible" });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out and cancels a stalled metadata response body", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        cancel,
      }), { status: 200 }));
      const result = resolveTerminalGatewayCompatibility({
        gatewayUrl: "https://gateway.example",
        sessionId: "main",
        signal: new AbortController().signal,
        fetchImpl,
      });

      await vi.advanceTimersByTimeAsync(TERMINAL_METADATA_FETCH_TIMEOUT_MS + 1);
      await expect(result).resolves.toEqual({ kind: "incompatible" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects oversized response bytes and row counts", async () => {
    const oversizedBody = `{"sessions":[],"padding":"${"x".repeat(MAX_TERMINAL_SESSION_METADATA_BYTES)}"}`;
    const oversizedRows = Array.from(
      { length: MAX_TERMINAL_SESSION_METADATA_ROWS + 1 },
      (_, index) => ({ name: `session-${index}` }),
    );
    const bodyProbe = probeOptions([new Response(oversizedBody, { status: 200 })]);
    const rowProbe = probeOptions([jsonResponse({ sessions: oversizedRows })]);

    await expect(resolveTerminalGatewayCompatibility(bodyProbe.options)).resolves.toEqual({
      kind: "incompatible",
    });
    await expect(resolveTerminalGatewayCompatibility(rowProbe.options)).resolves.toEqual({
      kind: "incompatible",
    });
  });
});
