import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { GithubDeveloperSetupOperationSchema } from "@matrix-os/contracts";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { getOptionalRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { registerGithubDeveloperSetup } from "../../packages/gateway/src/github-developer-setup.js";

const root = "/api/github/setup";
const code = "ABCD-1234";

function fixture(source: string, {
  writable = true, ready = true, timeoutMs = 10_000, canWrite = async () => writable,
}: { writable?: boolean; ready?: boolean; timeoutMs?: number; canWrite?: (signal: AbortSignal) => Promise<boolean> } = {}) {
  const app = new Hono();
  const spawnSetup = vi.fn(() => spawn(process.execPath, ["-e", source], {
    detached: true, stdio: ["ignore", "pipe", "ignore"],
  }));
  const checkReady = vi.fn(async () => ready);
  const lifecycle = registerGithubDeveloperSetup({
    app, ownerId: "owner", homePath: "/unused", spawnSetup, checkReady, timeoutMs, canWrite,
    getPrincipal: c => {
      const userId = c.req.header("x-fixture-user");
      return userId ? { userId } : null;
    },
  });
  const request = (path: string, method = "GET", body = "{}", user: string | null = "owner", contentType = "application/json") => app.request(path, {
    method, headers: { "content-type": contentType, ...(user ? { "x-fixture-user": user } : {}) },
    ...(method === "POST" ? { body } : {}),
  });
  const parse = async (response: Response) => GithubDeveloperSetupOperationSchema.parse(await response.json());
  return { ...lifecycle, request, parse, spawnSetup, checkReady };
}

describe("GitHub Developer Settings setup", () => {
  it("publishes only the device code and verifies readiness after the command exits", async () => {
    const setup = fixture(`process.stdout.write('{"device'); setTimeout(() => process.stdout.write('Code":"${code}"}\\n'), 30); process.stderr.write('private diagnostics'); setTimeout(() => {}, 500);`);
    try {
      const response = await setup.request(root, "POST");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const first = await setup.parse(response);
      expect(first).toEqual({ id: first.id, state: "starting" });
      expect(await setup.parse(await setup.request(root, "POST"))).toMatchObject({ id: first.id });
      const path = `${root}/${first.id}`;
      await vi.waitFor(async () => {
        expect(await setup.parse(await setup.request(path))).toEqual({ id: first.id, state: "awaiting_authorization", deviceCode: code });
      });
      expect(setup.checkReady).not.toHaveBeenCalled();
      await vi.waitFor(async () => {
        expect(await setup.parse(await setup.request(path))).toEqual({ id: first.id, state: "succeeded" });
      }, { timeout: 2500 });
      expect(setup.spawnSetup).toHaveBeenCalledOnce();
      expect(setup.checkReady).toHaveBeenCalledOnce();
    } finally { await setup.close(); }
  });

  it("denies unauthenticated users and other runtime principals, and validates the request", async () => {
    const setup = fixture("", { writable: false });
    try {
      expect((await setup.request(root, "POST", "{}", null)).status).toBe(401);
      expect((await setup.request(root, "POST", "{}", "collaborator")).status).toBe(403);
      expect((await setup.request(root, "POST", "{}", "owner", "text/plain")).status).toBe(400);
      expect((await setup.request(root, "POST", JSON.stringify({ command: "arbitrary" }))).status).toBe(400);
      expect((await setup.request(root, "POST", " ".repeat(900))).status).toBe(413);
      expect((await setup.request(`${root}/invalid`)).status).toBe(400);
      const operation = await setup.parse(await setup.request(root, "POST"));
      await vi.waitFor(async () => expect((await setup.parse(await setup.request(`${root}/${operation.id}`))).state).toBe("failed"));
      expect(setup.spawnSetup).not.toHaveBeenCalled();
    } finally { await setup.close(); }
  });

  it("clears the code on cancellation and reaps the child before releasing the operation", async () => {
    const setup = fixture(`console.log(JSON.stringify({ deviceCode: '${code}' })); setInterval(() => {}, 5000);`);
    try {
      const first = await setup.parse(await setup.request(root, "POST"));
      const path = `${root}/${first.id}`;
      await vi.waitFor(async () => expect(await setup.parse(await setup.request(path))).toMatchObject({ deviceCode: code }));
      const child = setup.spawnSetup.mock.results[0]?.value;
      expect(await setup.parse(await setup.request(`${path}/cancel`, "POST"))).toEqual({ id: first.id, state: "cancelled" });
      expect(await setup.parse(await setup.request(path))).toEqual({ id: first.id, state: "cancelled" });
      await vi.waitFor(() => expect(child?.signalCode).toBeTruthy());
      expect(setup.checkReady).not.toHaveBeenCalled();
    } finally { await setup.close(); }
  });

  it.each([
    ["rejects arbitrary stdout", "console.log('unsupported output')", true],
    ["rejects duplicate code events", `console.log('{"deviceCode":"${code}"}\\n{"deviceCode":"${code}"}')`, true],
    ["rejects a successful command without canonical readiness", "", false],
  ] as const)("%s", async (_name, source, ready) => {
    const setup = fixture(source, { ready });
    try {
      const first = await setup.parse(await setup.request(root, "POST"));
      await vi.waitFor(async () => {
        expect(await setup.parse(await setup.request(`${root}/${first.id}`))).toEqual({ id: first.id, state: "failed" });
      });
    } finally { await setup.close(); }
  });

  it("denies Preview collaborators through the real authentication boundary", async () => {
    const app = new Hono();
    const token = "synthetic-preview-runtime-token";
    app.use("*", authMiddleware(token));
    const canWrite = vi.fn(async () => false);
    const lifecycle = registerGithubDeveloperSetup({
      app, ownerId: "owner", homePath: "/unused", canWrite, checkReady: async () => false,
      getPrincipal: c => getOptionalRequestPrincipal(c, {
        configuredUserId: "owner", isTrustedSingleUserGateway: true, authEnabled: true,
        isProduction: true, isLocalDevelopment: false,
      }),
    });
    const request = (userId: string) => app.request(root, { method: "POST", body: "{}", headers: {
      "content-type": "application/json", authorization: `Bearer ${token}`, "x-platform-user-id": userId,
      "x-platform-verified": createHmac("sha256", token).update(userId).digest("hex"),
    } });
    try {
      const forbidden = await request("preview_collaborator");
      expect(forbidden.status).toBe(403);
      expect(forbidden.headers.get("cache-control")).toBe("private, no-store");
      expect(canWrite).not.toHaveBeenCalled();
      expect((await request("owner")).status).toBe(200);
      expect(canWrite).toHaveBeenCalledOnce();
    } finally { await lifecycle.close(); }
  });

  it("releases a cancelled attempt while permission is pending and rejects a late spawn", async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const canWrite = vi.fn<(signal: AbortSignal) => Promise<boolean>>().mockReturnValueOnce(promise).mockResolvedValueOnce(false);
    const setup = fixture("", { canWrite });
    try {
      const first = await setup.parse(await setup.request(root, "POST"));
      expect(await setup.parse(await setup.request(`${root}/${first.id}/cancel`, "POST"))).toEqual({ id: first.id, state: "cancelled" });
      expect(canWrite.mock.calls[0]?.[0].aborted).toBe(true);
      const second = await setup.parse(await setup.request(root, "POST"));
      expect(second.id).not.toBe(first.id);
      resolve(true);
      await vi.waitFor(async () => expect((await setup.parse(await setup.request(`${root}/${second.id}`))).state).toBe("failed"));
      expect(setup.spawnSetup).not.toHaveBeenCalled();
    } finally { resolve(false); await setup.close(); }
  });

  it("drains a child still waiting for authorization when the gateway closes", async () => {
    const setup = fixture(`console.log(JSON.stringify({ deviceCode: '${code}' })); setInterval(() => {}, 5000);`);
    try {
      const first = await setup.parse(await setup.request(root, "POST"));
      await vi.waitFor(async () => expect(await setup.parse(await setup.request(`${root}/${first.id}`))).toMatchObject({ deviceCode: code }));
      await setup.close();
      expect(setup.spawnSetup.mock.results[0]?.value.signalCode).toBeTruthy();
      expect((await setup.request(root, "POST")).status).toBe(503);
    } finally { await setup.close(); }
  });

  it("expires timed-out setup without exposing a code", async () => {
    const setup = fixture(`console.log(JSON.stringify({ deviceCode: '${code}' })); setInterval(() => {}, 5000);`, { timeoutMs: 100 });
    try {
      const first = await setup.parse(await setup.request(root, "POST"));
      await vi.waitFor(async () => {
        expect(await setup.parse(await setup.request(`${root}/${first.id}`))).toEqual({ id: first.id, state: "expired" });
      });
    } finally { await setup.close(); }
  });
});
