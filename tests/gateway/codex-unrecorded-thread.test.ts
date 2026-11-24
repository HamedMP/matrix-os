import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";
import { discardUnrecordedNativeThread } from "../../packages/gateway/src/coding-agents/codex-unrecorded-thread.mjs";

// Fault detected: a failed native account proof leaving an orphan Codex thread,
// or the discard step hanging/throwing and changing the fail-closed outcome.
describe("discardUnrecordedNativeThread", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("deletes the started thread by its identity with a bounded RPC", async () => {
    const request = vi.fn(async () => ({}));
    await expect(discardUnrecordedNativeThread(Promise.resolve({ ok: true, value: { thread: { id: "t-1" } } }), request, 50)).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("thread/delete", { threadId: "t-1" }, 50);
  });

  it("sends nothing when thread/start failed or returned no valid identity", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = vi.fn(async () => ({}));
    await expect(discardUnrecordedNativeThread(Promise.resolve({ ok: false, error: new Error("x") }), request, 50)).resolves.toBe(false);
    await expect(discardUnrecordedNativeThread(Promise.resolve({ ok: true, value: { thread: { id: "" } } }), request, 50)).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("gives up without throwing when thread/start never settles", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = vi.fn(async () => ({}));
    await expect(discardUnrecordedNativeThread(new Promise(() => undefined), request, 20)).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.any(String), "thread_start", "DiscardTimeout");
  });

  it("logs only the error name when thread/delete fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = vi.fn(async () => { throw new TypeError("provider detail /secret/path"); });
    await expect(discardUnrecordedNativeThread(Promise.resolve({ ok: true, value: { thread: { id: "t-1" } } }), request, 50)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.any(String), "thread_delete", "TypeError");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("/secret/path");
  });
});

type Schema = { definitions: Record<string, any> & { v2: Record<string, any> } };
function appServerSchema(version: string): Schema {
  return JSON.parse(gunzipSync(readFileSync(new URL(`../fixtures/codex-${version}/app-server-schema-${version}.json.gz`, import.meta.url))).toString("utf8"));
}
function threadDeleteContract(schema: Schema) {
  const branches = schema.definitions.ClientRequest.oneOf.filter((branch: any) => branch.properties?.method?.enum?.[0] === "thread/delete");
  return { branches, params: schema.definitions.v2.ThreadDeleteParams, response: schema.definitions.v2.ThreadDeleteResponse };
}

// The discard relies on thread/delete from the retained generated schemas, not an invented call.
it("uses the thread/delete request retained unchanged from the verified Codex version through 0.171", () => {
  expect(CODEX_VERIFIED_VERSION).toMatch(/^0\.162\./);
  const verified = threadDeleteContract(appServerSchema("0162"));
  expect(verified.branches).toHaveLength(1);
  expect(verified.branches[0]).toMatchObject({ required: ["id", "method", "params"], properties: { params: { $ref: "#/definitions/v2/ThreadDeleteParams" } } });
  expect(verified.params).toMatchObject({ required: ["threadId"], properties: { threadId: { type: "string" } } });
  expect(Object.keys(verified.params.properties)).toEqual(["threadId"]);
  expect(threadDeleteContract(appServerSchema("0171"))).toEqual(verified);
});
