import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { requestHasBody } from "../../packages/gateway/src/http-body.js";

function contextWithHeaders(headers: Record<string, string | undefined>, body: ReadableStream<Uint8Array> | null): Context {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    req: {
      header: (name: string) => normalized[name.toLowerCase()],
      raw: { body },
    },
  } as unknown as Context;
}

describe("requestHasBody", () => {
  it("trusts explicit zero content length over adapter body streams", () => {
    const body = new ReadableStream<Uint8Array>();

    expect(requestHasBody(contextWithHeaders({ "content-length": "0" }, body))).toBe(false);
  });

  it("does not treat malformed content length as body-present by itself", () => {
    expect(requestHasBody(contextWithHeaders({
      "content-length": "abc",
      "content-type": "application/json",
    }, null))).toBe(false);
  });

  it("treats transfer-encoded requests as body-bearing", () => {
    expect(requestHasBody(contextWithHeaders({ "transfer-encoding": "chunked" }, null))).toBe(true);
  });

  it("does not infer a body from an adapter stream when body headers are absent", () => {
    const body = new ReadableStream<Uint8Array>();

    expect(requestHasBody(contextWithHeaders({}, body))).toBe(false);
  });

  it("uses content type as the fallback signal for stream-backed requests", () => {
    const body = new ReadableStream<Uint8Array>();

    expect(requestHasBody(contextWithHeaders({ "content-type": "application/json" }, body))).toBe(true);
  });
});
