import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  previewCommand,
  runPreviewDestroy,
  runPreviewList,
  runPreviewStart,
  runPreviewUpdate,
} from "../../packages/sync-client/src/cli/commands/preview.js";

const platform = "https://platform.test";
const base = { platform, token: "cli-token" };
const bundle = {
  pr: 1907,
  version: "v2026.09.28-pr1907-1-1-abcdef0",
  gitCommit: "abcdef0123456789",
  author: "octo-dev",
  createdAt: "2026-09-28T00:00:00.000Z",
};
const newer = { ...bundle, version: "v2026.09.29-pr1907-2-1-1234567", gitCommit: "1234567890abcdef" };
const machine = {
  machineId: "00000000-0000-4000-8000-000000001907",
  handle: "pv-1907-3fa91c2e",
  pr: 1907,
  confirmedBundleVersion: bundle.version,
  status: "running",
  provisionedAt: "2026-09-28T00:00:00.000Z",
  expiresAt: "2026-10-01T00:00:00.000Z",
};

type Route = (init: RequestInit) => [number, unknown];

function platformServer(routes: Record<string, Route>) {
  const calls: Array<{ method: string; path: string; body?: unknown; authorization?: string }> = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const key = `${method} ${url.pathname}${url.search}`;
    const headers = new Headers(init.headers);
    calls.push({
      method,
      path: `${url.pathname}${url.search}`,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.get("authorization") ?? undefined,
    });
    const route = routes[key];
    const [status, body] = route ? route(init) : [404, { error: "Not found" }];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => { out.push(String(line)); });
  vi.spyOn(console, "error").mockImplementation((line?: unknown) => { err.push(String(line)); });
  return { out, err };
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("matrix preview", () => {
  it("registers start, update, list, and destroy", () => {
    expect(Object.keys(previewCommand.subCommands ?? {}).sort()).toEqual(["destroy", "list", "start", "update"]);
  });

  it("shows the exact bundle and starts only that version after confirmation", async () => {
    let started = false;
    const calls = platformServer({
      "GET /api/private-previews/bundles?pr=1907": () => [200, bundle],
      "GET /api/private-previews": () => [200, { privatePreviews: started ? [{ ...machine, status: "provisioning" }] : [] }],
      "POST /api/private-previews": () => {
        started = true;
        return [202, { machineId: machine.machineId, handle: machine.handle, status: "provisioning", etaSeconds: 300 }];
      },
    });
    const { out } = capture();
    const confirm = vi.fn(async () => true);

    await runPreviewStart({ ...base, pr: "1907" }, { confirm });

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(bundle.version));
    expect(confirm.mock.calls[0]![0]).toContain("abcdef0");
    expect(confirm.mock.calls[0]![0]).toContain("octo-dev");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/private-previews/bundles?pr=1907",
      "GET /api/private-previews",
      "POST /api/private-previews",
      "GET /api/private-previews",
    ]);
    expect(calls[2]!.body).toEqual({ pr: 1907, bundleVersion: bundle.version });
    expect(calls.every((call) => call.authorization === "Bearer cli-token")).toBe(true);
    expect(out.join("\n")).toContain(`${platform}/vm/${machine.handle}`);
    expect(process.exitCode).toBeUndefined();
  });

  it("starts nothing when the owner declines", async () => {
    const calls = platformServer({
      "GET /api/private-previews/bundles?pr=1907": () => [200, bundle],
      "GET /api/private-previews": () => [200, { privatePreviews: [] }],
    });
    capture();
    await runPreviewStart({ ...base, pr: "1907" }, { confirm: async () => false });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
  });

  it("requires --yes when it cannot ask", async () => {
    const calls = platformServer({
      "GET /api/private-previews/bundles?pr=1907": () => [200, bundle],
      "GET /api/private-previews": () => [200, { privatePreviews: [] }],
    });
    const { err } = capture();
    await runPreviewStart({ ...base, pr: "1907" }, { interactive: false });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(err.join("\n")).toContain("--yes");
    expect(process.exitCode).toBe(1);
  });

  it("skips the prompt with --yes", async () => {
    let started = false;
    const calls = platformServer({
      "GET /api/private-previews/bundles?pr=1907": () => [200, bundle],
      "GET /api/private-previews": () => [200, { privatePreviews: started ? [machine] : [] }],
      "POST /api/private-previews": () => {
        started = true;
        return [202, { machineId: machine.machineId, handle: machine.handle, status: "provisioning", etaSeconds: 300 }];
      },
    });
    capture();
    await runPreviewStart({ ...base, pr: "1907", yes: true }, { interactive: false });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "POST", "GET"]);
    expect(process.exitCode).toBeUndefined();
  });

  it("points to the existing Private Preview instead of starting a second one", async () => {
    const calls = platformServer({
      "GET /api/private-previews/bundles?pr=1907": () => [200, bundle],
      "GET /api/private-previews": () => [200, { privatePreviews: [machine] }],
    });
    const { out } = capture();
    const confirm = vi.fn(async () => true);
    await runPreviewStart({ ...base, pr: "1907" }, { confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(out.join("\n")).toContain(`${platform}/vm/${machine.handle}`);
    expect(process.exitCode).toBeUndefined();
  });

  it("does not claim a newer bundle when the existing Private Preview runs an older one", async () => {
    const calls = platformServer({
      "GET /api/private-previews/bundles?pr=1907": () => [200, newer],
      "GET /api/private-previews": () => [200, { privatePreviews: [machine] }],
    });
    const { err } = capture();
    await runPreviewStart({ ...base, pr: "1907", yes: true }, { interactive: false });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(err.join("\n")).toContain("matrix preview update 1907");
    expect(err.join("\n")).toContain(bundle.version);
    expect(process.exitCode).toBe(1);
  });

  it("reports a concurrent start that kept another bundle", async () => {
    let started = false;
    platformServer({
      "GET /api/private-previews/bundles?pr=1907": () => [200, newer],
      "GET /api/private-previews": () => [200, { privatePreviews: started ? [machine] : [] }],
      "POST /api/private-previews": () => {
        started = true;
        return [202, { machineId: machine.machineId, handle: machine.handle, status: "running" }];
      },
    });
    const { out, err } = capture();
    await runPreviewStart({ ...base, pr: "1907", yes: true }, { interactive: false });
    expect(out.join("\n")).not.toContain("Open it at");
    expect(err.join("\n")).toContain("matrix preview update 1907");
    expect(process.exitCode).toBe(1);
  });

  it("rejects an invalid PR number before any request", async () => {
    const calls = platformServer({});
    const { err } = capture();
    for (const pr of ["0", "abc", "1000000000", "-3"]) {
      await runPreviewStart({ ...base, pr, yes: true }, { interactive: false });
    }
    expect(calls).toHaveLength(0);
    expect(err.join("\n")).toContain("PR number");
  });

  it.each([
    [401, "matrix login"],
    [403, "team members"],
    [404, "preview-bundle"],
  ])("explains a %s from the bundle lookup", async (status, hint) => {
    platformServer({ "GET /api/private-previews/bundles?pr=1907": () => [status, { error: "x" }] });
    const { err } = capture();
    await runPreviewStart({ ...base, pr: "1907", yes: true }, { interactive: false });
    expect(err.join("\n")).toContain(hint);
    expect(process.exitCode).toBe(1);
  });

  it("updates to the newest bundle only after confirmation", async () => {
    const calls = platformServer({
      "GET /api/private-previews": () => [200, { privatePreviews: [machine] }],
      "GET /api/private-previews/bundles?pr=1907": () => [200, newer],
      [`POST /api/private-previews/${machine.machineId}/deploy`]: () => [202, { machineId: machine.machineId, status: "updating" }],
    });
    capture();
    const confirm = vi.fn(async () => true);
    await runPreviewUpdate({ ...base, pr: "1907" }, { confirm });
    expect(confirm.mock.calls[0]![0]).toContain(newer.version);
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { bundleVersion: newer.version } });
  });

  it("says a matching version is confirmed, not installed, and sends nothing without --yes", async () => {
    const calls = platformServer({
      "GET /api/private-previews": () => [200, { privatePreviews: [machine] }],
      "GET /api/private-previews/bundles?pr=1907": () => [200, bundle],
    });
    const { out } = capture();
    await runPreviewUpdate({ ...base, pr: "1907" }, { interactive: false });
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    const text = out.join("\n");
    expect(text).toContain("already confirmed");
    expect(text).not.toContain("runs");
    expect(text).toContain("--yes");
    expect(process.exitCode).toBeUndefined();
  });

  it("can ask for the confirmed version again after a failed install", async () => {
    const calls = platformServer({
      "GET /api/private-previews": () => [200, { privatePreviews: [machine] }],
      "GET /api/private-previews/bundles?pr=1907": () => [200, bundle],
      [`POST /api/private-previews/${machine.machineId}/deploy`]: () => [202, { machineId: machine.machineId, status: "updating" }],
    });
    capture();
    const confirm = vi.fn(async () => true);
    await runPreviewUpdate({ ...base, pr: "1907" }, { confirm });
    expect(confirm.mock.calls[0]![0]).toContain("install");
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { bundleVersion: bundle.version } });
  });

  it("destroys the owner's Private Preview for a PR after confirmation", async () => {
    const calls = platformServer({
      "GET /api/private-previews": () => [200, { privatePreviews: [machine] }],
      [`DELETE /api/private-previews/${machine.machineId}`]: () => [202, { machineId: machine.machineId, status: "deleted" }],
    });
    capture();
    await runPreviewDestroy({ ...base, pr: "1907" }, { confirm: async () => true });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("reports when there is no Private Preview for a PR", async () => {
    platformServer({ "GET /api/private-previews": () => [200, { privatePreviews: [] }] });
    const { err } = capture();
    await runPreviewDestroy({ ...base, pr: "1907", yes: true }, { interactive: false });
    expect(err.join("\n")).toContain("No Private Preview for PR #1907");
    expect(process.exitCode).toBe(1);
  });

  it("lists Private Previews with their URL and expiry, or as JSON", async () => {
    platformServer({ "GET /api/private-previews": () => [200, { privatePreviews: [machine] }] });
    const { out } = capture();
    await runPreviewList(base);
    const text = out.join("\n");
    expect(text).toContain("#1907");
    expect(text).toContain(machine.handle);
    expect(text).toContain(`${platform}/vm/${machine.handle}`);
    expect(text).toContain(machine.expiresAt);

    out.length = 0;
    await runPreviewList({ ...base, json: true });
    expect(JSON.parse(out.join(""))).toMatchObject({ ok: true, data: { privatePreviews: [{ handle: machine.handle }] } });
  });
});
