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
    const readToken = vi.fn(async () => token);
    const rpc = createLazyOpenClawRpc("/owner/home", {
      readToken,
      createClient: () => client,
    });

    const call = rpc.call("health", {}, new AbortController().signal);
    await vi.waitFor(() => expect(readToken).toHaveBeenCalledOnce());
    const close = rpc.close();
    resolveToken?.("a".repeat(64));

    await expect(call).rejects.toMatchObject({ kind: "runtime_unavailable" });
    await close;
    expect(client.call).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("recreates the lazy OpenClaw client after a lifecycle reset", async () => {
    const clients = [
      {
        call: vi.fn(async () => ({ generation: 1 })),
        close: vi.fn(async () => {}),
      },
      {
        call: vi.fn(async () => ({ generation: 2 })),
        close: vi.fn(async () => {}),
      },
    ];
    const createClient = vi.fn(() => {
      const client = clients[createClient.mock.calls.length - 1];
      if (!client) throw new Error("Unexpected OpenClaw client creation");
      return client;
    });
    const rpc = createLazyOpenClawRpc("/owner/home", {
      readToken: vi.fn(async () => "a".repeat(64)),
      createClient,
    });

    await expect(rpc.call("health", {}, new AbortController().signal))
      .resolves.toEqual({ generation: 1 });
    await rpc.reset();
    await expect(rpc.call("health", {}, new AbortController().signal))
      .resolves.toEqual({ generation: 2 });

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(clients[0]?.close).toHaveBeenCalledOnce();
    await rpc.close();
    expect(clients[1]?.close).toHaveBeenCalledOnce();
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
    expect(lifecycleCalls).toEqual(["switch:hermes"]);
    await services.controller.close();
    expect(openClawRpc.close).toHaveBeenCalledOnce();
  });

  it("does not disable runtimes when startup inventory is temporarily unhealthy", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "agent-runtime-services-"));
    cleanupPaths.push(homePath);
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(join(homePath, "system/config.json"), JSON.stringify({
      agent: { messagingRuntime: "hermes", revision: 0 },
    }));
    const hostControl = {
      status: vi.fn(async () => ({
        hermes: { installed: true, running: true },
        openclaw: { installed: true, running: false },
      })),
      switch: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const services = createAgentRuntimeServices({
      homePath,
      client: {
        readJson: vi.fn(async () => { throw new Error("dashboard starting"); }),
        requestJson: vi.fn(async () => ({ ok: true })),
      },
      hostControl,
      openClawRpc: {
        call: vi.fn(async () => { throw new Error("not selected"); }),
        close: vi.fn(async () => {}),
      },
    });

    await expect(services.controller.reconcile()).resolves.toBeUndefined();
    expect(hostControl.stop).not.toHaveBeenCalled();
    await services.controller.close();
  });

  it("clears configured messaging selection when its catalog is unavailable", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "agent-runtime-services-"));
    cleanupPaths.push(homePath);
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(join(homePath, "system/config.json"), JSON.stringify({
      agent: { messagingRuntime: "openclaw", revision: 0 },
    }));
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
        call: vi.fn(async (method: string) => {
          if (method === "health") return { ts: 1_789_000_000_000 };
          if (method === "models.list") throw new Error("catalog unavailable");
          if (method === "models.authStatus") {
            return { ts: 1_789_000_000_000, providers: [] };
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
      },
    });

    await expect(services.source(new AbortController().signal)).resolves.toMatchObject({
      providers: [],
      messaging: {
        runtime: "openclaw",
        provider: null,
        model: null,
        configured: false,
      },
    });
    await services.controller.close();
  });

  it("waits for fresh OpenClaw RPC readiness before committing a switch", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "agent-runtime-services-"));
    cleanupPaths.push(homePath);
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(join(homePath, "system/config.json"), JSON.stringify({
      agent: { messagingRuntime: "hermes", revision: 0 },
    }));
    let active: "hermes" | "openclaw" = "hermes";
    let healthCalls = 0;
    const reset = vi.fn(async () => {});
    const hostControl = {
      status: vi.fn(async () => ({
        hermes: { installed: true, running: active === "hermes" },
        openclaw: { installed: true, running: active === "openclaw" },
      })),
      switch: vi.fn(async (runtime: "hermes" | "openclaw") => {
        active = runtime;
      }),
      stop: vi.fn(async () => {}),
    };
    const openClawRpc = {
      call: vi.fn(async (method: string) => {
        if (method === "health") {
          healthCalls += 1;
          if (healthCalls < 3) throw new Error("gateway binding");
          return { ts: 1_789_000_000_000 };
        }
        if (method === "models.list") {
          return { models: [{
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            provider: "anthropic",
            available: true,
          }] };
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
      reset,
    };
    const services = createAgentRuntimeServices({
      homePath,
      client: {
        readJson: vi.fn(async (path: string) => path === "/api/status"
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
            }),
        requestJson: vi.fn(async () => ({ ok: true })),
      },
      hostControl,
      openClawRpc,
    });

    await expect(services.controller.update({ runtime: "openclaw", revision: 0 }))
      .resolves.toMatchObject({ runtime: "openclaw", revision: 1 });
    expect(reset).toHaveBeenCalled();
    expect(healthCalls).toBeGreaterThanOrEqual(3);
    expect(hostControl.stop).not.toHaveBeenCalled();
    await services.controller.close();
  });

  it("invalidates Hermes inventory across an away-and-back lifecycle switch", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "agent-runtime-services-"));
    cleanupPaths.push(homePath);
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(join(homePath, "system/config.json"), JSON.stringify({
      agent: { messagingRuntime: "hermes", revision: 0 },
    }));
    let active: "hermes" | "openclaw" = "hermes";
    const hostControl = {
      status: vi.fn(async () => ({
        hermes: { installed: true, running: active === "hermes" },
        openclaw: { installed: true, running: active === "openclaw" },
      })),
      switch: vi.fn(async (runtime: "hermes" | "openclaw") => {
        active = runtime;
      }),
      stop: vi.fn(async () => {}),
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
          return { models: [{
            id: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            provider: "anthropic",
            available: true,
          }] };
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
      reset: vi.fn(async () => {}),
    };
    const services = createAgentRuntimeServices({
      homePath,
      client: { readJson, requestJson: vi.fn(async () => ({ ok: true })) },
      hostControl,
      openClawRpc,
    });

    await services.source(new AbortController().signal);
    expect(readJson).toHaveBeenCalledTimes(2);
    await services.controller.update({ runtime: "openclaw", revision: 0 });
    await services.controller.update({ runtime: "hermes", revision: 1 });

    expect(readJson).toHaveBeenCalledTimes(4);
    expect(hostControl.stop).not.toHaveBeenCalled();
    await services.controller.close();
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
