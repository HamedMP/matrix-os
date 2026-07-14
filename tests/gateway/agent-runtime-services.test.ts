import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentRuntimeServices,
  createHermesAgentRuntimeServices,
  createLazyOpenClawRpc,
} from "../../packages/gateway/src/agent-config/runtime-services.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("Hermes agent runtime services", () => {
  it("does not release a newly created OpenClaw client to callers after shutdown starts", async () => {
    let resolveToken: ((token: string) => void) | undefined;
    const token = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });
    const client = {
      call: vi.fn(async () => ({ ok: true })),
      close: vi.fn(async () => {}),
    };
    const rpc = createLazyOpenClawRpc("/owner/home", {
      readToken: async () => token,
      createClient: () => client,
    });

    const call = rpc.call("health", {}, new AbortController().signal);
    const close = rpc.close();
    resolveToken?.("a".repeat(64));

    await expect(call).rejects.toMatchObject({ kind: "runtime_unavailable" });
    await close;
    expect(client.call).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("wires the unified runtime services into gateway startup and shutdown", async () => {
    const server = await readFile("packages/gateway/src/server.ts", "utf8");

    expect(server).toContain('import { createAgentRuntimeServices } from "./agent-config/runtime-services.js";');
    expect(server).toContain("const agentRuntimeServices = createAgentRuntimeServices({");
    expect(server).toContain("await agentRuntimeServices.controller.reconcile();");
    expect(server).toContain("await agentRuntimeServices.controller.close();");
    expect(server).not.toContain("createHermesAgentRuntimeServices");
  });

  it("wires a catalog-backed model mutation through to owner config", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "agent-runtime-services-"));
    cleanupPaths.push(homePath);
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(join(homePath, "system/config.json"), "{}");
    let model = "hermes-3";
    const readJson = vi.fn(async (path: string) => path === "/api/status"
      ? { gateway_running: true }
      : {
          provider: "nous",
          model,
          providers: [{
            slug: "nous",
            name: "Nous",
            authenticated: true,
            auth_type: "oauth",
            models: ["hermes-3", "hermes-4-405b"],
          }],
        });
    const requestJson = vi.fn(async () => {
      model = "hermes-4-405b";
      return { ok: true };
    });
    const services = createHermesAgentRuntimeServices({
      homePath,
      client: { readJson, requestJson },
    });

    await expect(services.controller.update({
      provider: "nous",
      messagingModel: "hermes-4-405b",
      revision: 0,
    })).resolves.toMatchObject({
      runtime: "hermes",
      revision: 1,
      selection: { provider: "nous", model: "hermes-4-405b" },
    });

    expect(requestJson).toHaveBeenCalledWith(
      "/api/model/set",
      expect.objectContaining({ method: "POST" }),
      expect.any(AbortSignal),
    );
    await expect(readFile(join(homePath, "system/config.json"), "utf8"))
      .resolves.toContain('"revision": 1');
    await services.controller.close();
  });

  it("composes OpenClaw inventory and fixed lifecycle switching without requiring it at startup", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "agent-runtime-services-"));
    cleanupPaths.push(homePath);
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(join(homePath, "system/config.json"), JSON.stringify({
      agent: { messagingRuntime: "openclaw", revision: 0 },
    }));
    let active: "hermes" | "openclaw" = "openclaw";
    const lifecycleCalls: string[] = [];
    const hostControl = {
      status: vi.fn(async () => ({
        hermes: { installed: true, running: active === "hermes" },
        openclaw: { installed: true, running: active === "openclaw" },
      })),
      switch: vi.fn(async (runtime: "hermes" | "openclaw") => {
        lifecycleCalls.push(`switch:${runtime}`);
        active = runtime;
      }),
      stop: vi.fn(async (runtime: "hermes" | "openclaw") => {
        lifecycleCalls.push(`stop:${runtime}`);
      }),
    };
    const readJson = vi.fn(async (path: string) => path === "/api/status"
      ? { gateway_running: active === "hermes" }
      : {
          provider: "nous",
          model: "hermes-4-405b",
          providers: [{
            slug: "nous",
            name: "Nous",
            authenticated: true,
            auth_type: "oauth",
            models: ["hermes-4-405b"],
          }],
        });
    const openClawRpc = {
      call: vi.fn(async (method: string) => {
        if (method === "health") return { ts: 1_789_000_000_000 };
        if (method === "models.list") {
          return {
            models: [{
              id: "claude-opus-4-6",
              name: "Claude Opus 4.6",
              provider: "anthropic",
              available: true,
            }],
          };
        }
        if (method === "models.authStatus") {
          return {
            ts: 1_789_000_000_000,
            providers: [{
              provider: "anthropic",
              displayName: "Anthropic",
              status: "ok",
              profiles: [{ profileId: "default", type: "oauth", status: "ok" }],
            }],
          };
        }
        if (method === "config.get") {
          return {
            valid: true,
            hash: "config-hash",
            config: { agents: { defaults: { model: {
              primary: "anthropic/claude-opus-4-6",
            } } } },
          };
        }
        throw new Error("Unexpected OpenClaw method");
      }),
      close: vi.fn(async () => {}),
    };
    const services = createAgentRuntimeServices({
      homePath,
      client: { readJson, requestJson: vi.fn(async () => ({ ok: true })) },
      hostControl,
      openClawRpc,
    });

    await expect(services.source(new AbortController().signal)).resolves.toMatchObject({
      runtime: {
        selected: "openclaw",
        options: [
          { id: "hermes", installState: "installed", selectionState: "available" },
          { id: "openclaw", health: "healthy", selectionState: "active" },
        ],
      },
      providers: [{ id: "anthropic", runtime: "openclaw" }],
      messaging: {
        runtime: "openclaw",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
    });

    await expect(services.controller.update({ runtime: "hermes", revision: 0 }))
      .resolves.toMatchObject({ runtime: "hermes" });
    expect(lifecycleCalls).toEqual(["stop:openclaw", "switch:hermes"]);
    await services.controller.close();
    expect(openClawRpc.close).toHaveBeenCalledOnce();
  });

  it("propagates cancellation while active runtime inventory is settling", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "agent-runtime-services-"));
    cleanupPaths.push(homePath);
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(join(homePath, "system/config.json"), JSON.stringify({
      agent: { messagingRuntime: "openclaw", revision: 0 },
    }));
    const controller = new AbortController();
    const services = createAgentRuntimeServices({
      homePath,
      client: {
        readJson: vi.fn(async () => ({ gateway_running: false })),
        requestJson: vi.fn(async () => ({ ok: true })),
      },
      hostControl: {
        status: vi.fn(async () => ({
          hermes: { installed: true, running: false },
          openclaw: { installed: true, running: true },
        })),
        switch: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      },
      openClawRpc: {
        call: vi.fn(async () => {
          controller.abort(new Error("request cancelled"));
          throw controller.signal.reason;
        }),
        close: vi.fn(async () => {}),
      },
    });

    await expect(services.source(controller.signal)).rejects.toThrow("request cancelled");
    await services.controller.close();
  });
});
