/**
 * The shared feature route pieces (api/feature-route-kit.ts) every feature router uses: Cache-Control on every
 * answer, principal first, then the service being on, then the project ref; fixed error bodies; a logged 503 for
 * anything unknown; body limits. Each feature's own route tests cover only its queries and bodies.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import {
  brainBodyLimit, brainProjectRoute, readBrainBody,
} from "../../packages/gateway/src/brain/api/feature-route-kit.js";
import { BrainApiError } from "../../packages/gateway/src/brain/api/types.js";
import { BrainFeatureError } from "../../packages/gateway/src/brain/contracts.js";
import { BrainStoreError } from "../../packages/gateway/src/brain/types.js";
import {
  MissingRequestPrincipalError, RequestPrincipalMisconfiguredError, type RequestPrincipal,
} from "../../packages/gateway/src/request-principal.js";

const OWNER: RequestPrincipal = { userId: "owner_a", source: "dev-default" };

function router(service: { run(): Promise<unknown> } | null, getPrincipal: () => RequestPrincipal = () => OWNER) {
  const app = new Hono();
  const route = brainProjectRoute({ service, getPrincipal }, "brain-test");
  app.get("/projects/:projectId/x", route(async (c, ownerId, svc, projectRef) =>
    c.json({ ownerId, projectRef, value: await svc.run() }, 200)));
  app.post("/projects/:projectId/x", brainBodyLimit(64), route(async (c) =>
    c.json(await readBrainBody(c, z.object({ a: z.number() }).strict()), 200)));
  app.post("/projects/:projectId/optional", brainBodyLimit(64), route(async (c) =>
    c.json(await readBrainBody(c, z.object({ a: z.number().optional() }).strict()), 200)));
  return app;
}

async function call(app: Hono, path: string, init?: RequestInit) {
  const response = await app.request(path, init);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return { status: response.status, body: await response.json() as { error?: { code: string; message: string } } };
}

describe("brain feature route kit", () => {
  it("checks the principal, then the service, then the project ref, and passes the owner and ref on", async () => {
    const ok = { run: async () => 1 };
    expect((await call(router(null, () => { throw new MissingRequestPrincipalError(); }), "/projects/proj_a/x")).status)
      .toBe(401);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await call(router(null, () => { throw new RequestPrincipalMisconfiguredError(); }), "/projects/proj_a/x"))
      .status).toBe(500);
    expect(error).toHaveBeenCalledWith("[brain-test] Request principal misconfigured:", "RequestPrincipalMisconfiguredError");
    expect(await call(router(null), "/projects/proj_a/x")).toMatchObject({ status: 503,
      body: { error: { code: "brain_unavailable", message: "Company brain is unavailable" } } });
    expect(await call(router(ok), "/projects/Not_A_Ref!/x")).toMatchObject({ status: 404,
      body: { error: { code: "project_not_found" } } });
    expect((await call(router(ok), "/projects/widgets/x")).body).toEqual({ ownerId: "owner_a", projectRef: "widgets", value: 1 });
    error.mockRestore();
  });

  it("maps feature, API, store, parse and body errors to fixed bodies and logs anything else by name", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cases: [unknown, number, string][] = [
      [new BrainFeatureError("alias_conflict"), 409, "alias_conflict"],
      [new BrainApiError("project_not_found"), 404, "project_not_found"],
      [new BrainStoreError("capacity"), 409, "brain_capacity"],
      [new BrainStoreError("invalid"), 400, "invalid_request"],
      [new SyntaxError("x"), 400, "invalid_request"],
      [Object.assign(new Error("x"), { name: "BodyLimitError" }), 413, "body_too_large"],
      [new TypeError("postgres said /home/secret"), 503, "brain_unavailable"],
      ["text", 503, "brain_unavailable"],
    ];
    for (const [thrown, status, code] of cases) {
      const result = await call(router({ run: async () => { throw thrown; } }), "/projects/proj_a/x");
      expect(result).toMatchObject({ status, body: { error: { code } } });
      expect(JSON.stringify(result.body)).not.toMatch(/postgres|secret/);
    }
    expect(error).toHaveBeenCalledWith("[brain-test] Request failed:", "TypeError");
    expect(error).toHaveBeenCalledWith("[brain-test] Request failed:", "UnknownError");
    const app = router({ run: async () => 1 });
    const post = (body: string) => ({ method: "POST", body, headers: { "content-type": "application/json" } });
    expect(await call(app, "/projects/proj_a/x", post('{"a":1}'))).toEqual({ status: 200, body: { a: 1 } });
    expect((await call(app, "/projects/proj_a/x", post('{"a":1,"b":2}'))).status).toBe(400);
    expect((await call(app, "/projects/proj_a/x", post(JSON.stringify({ a: 1, pad: "x".repeat(100) })))).status).toBe(413);
    expect(await call(app, "/projects/proj_a/x", { method: "POST" })).toMatchObject({ status: 400 });
    error.mockRestore();
  });

  it("reads an empty body as {} however it arrives, and still rejects bad JSON", async () => {
    const app = router({ run: async () => 1 });
    const emptyStream = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    const post = (body: BodyInit | undefined, headers: Record<string, string>) =>
      ({ method: "POST", body, headers, duplex: "half" }) as RequestInit;
    const json = { "content-type": "application/json" };
    for (const init of [
      { method: "POST" },
      post("", json),
      post("", { ...json, "content-length": "0" }),
      post(emptyStream(), { ...json, "transfer-encoding": "chunked" }),
      post(emptyStream(), { "transfer-encoding": "chunked" }),
      post(" \n", json),
    ]) {
      expect(await call(app, "/projects/proj_a/optional", init)).toEqual({ status: 200, body: {} });
    }
    expect(await call(app, "/projects/proj_a/optional", post('{"a":2}', json))).toEqual({ status: 200, body: { a: 2 } });
    for (const bad of ["{", "null", "[]", "x"]) {
      expect(await call(app, "/projects/proj_a/optional", post(bad, json))).toMatchObject({
        status: 400, body: { error: { code: "invalid_request" } },
      });
    }
  });
});
