import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProtocolRequest, ProtocolResponse, SupervisorClient } from "@matrix-os/terminal-runtime";
import {
  initializeGatewayTerminalRuntime,
  resolveGatewayTerminalRuntimeMode,
  type GatewayTerminalRuntimeClient,
} from "../../packages/gateway/src/shell/runtime-client.js";

const RUNTIME_ID = "0123456789abcdef0123456789abcdef";
const roots: string[] = [];

function supervisor(
  respond: (request: ProtocolRequest) => ProtocolResponse,
): SupervisorClient {
  return { request: vi.fn(async (request) => respond(request)) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("gateway terminal runtime client", () => {
  it("activates supervised ownership only for the production app generation", () => {
    expect(resolveGatewayTerminalRuntimeMode(undefined, "production")).toBe("supervised");
    expect(resolveGatewayTerminalRuntimeMode("", "production")).toBe("supervised");
    expect(resolveGatewayTerminalRuntimeMode(undefined, "development")).toBe("legacy");
    expect(resolveGatewayTerminalRuntimeMode(undefined, "test")).toBe("legacy");
    expect(resolveGatewayTerminalRuntimeMode("legacy", "production")).toBe("legacy");
    expect(resolveGatewayTerminalRuntimeMode("supervised", "development")).toBe("supervised");
    expect(() => resolveGatewayTerminalRuntimeMode("fallback", "production"))
      .toThrow("terminal_runtime_mode_invalid");
  });
  it("retains direct spawn when the dormant production mode is legacy", async () => {
    await expect(initializeGatewayTerminalRuntime({
      mode: "legacy",
      nodeEnv: "production",
      homePath: "/home/matrix/home",
    })).resolves.toBeNull();
  });

  it("fails closed when supervised production cannot complete a protocol-v1 List", async () => {
    const client = supervisor(() => {
      throw new Error("socket unavailable");
    });

    await expect(initializeGatewayTerminalRuntime({
      mode: "supervised",
      nodeEnv: "production",
      homePath: "/home/matrix/home",
      supervisor: client,
    })).rejects.toThrow("terminal_supervisor_unavailable");
  });

  it("probes compatibility and sends only validated protocol operations", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-client-"));
    roots.push(homePath);
    await mkdir(join(homePath, "projects", "example"), { recursive: true });
    const request = vi.fn(async (input: ProtocolRequest): Promise<ProtocolResponse> => {
      if (input.operation === "List") {
        return {
          version: 1,
          ok: true,
          operationId: input.operationId,
          result: [],
        };
      }
      if (input.operation === "CreateStart") {
        return {
          version: 1,
          ok: true,
          operationId: input.operationId,
          result: { runtimeId: RUNTIME_ID, lifecycleState: "starting" },
        };
      }
      throw new Error("unexpected operation");
    });

    const runtime = await initializeGatewayTerminalRuntime({
      mode: "supervised",
      nodeEnv: "production",
      homePath,
      supervisor: { request },
    });
    expect(runtime).not.toBeNull();
    const cwd = await realpath(join(homePath, "projects", "example"));
    await (runtime as GatewayTerminalRuntimeClient).createShell({
      displayName: "calm-otter",
      cwd,
    });

    expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({
      version: 1,
      operation: "List",
      input: {},
    }));
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
      version: 1,
      operation: "CreateStart",
      input: {
        displayName: "calm-otter",
        cwd: { kind: "home-relative", path: "projects/example" },
        launch: { kind: "shell" },
      },
    }));
    expect(JSON.stringify(request.mock.calls)).not.toContain(cwd);
  });

  it("rejects cwd escape before contacting the supervisor", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-client-"));
    const outside = await mkdtemp(join(tmpdir(), "matrix-terminal-outside-"));
    roots.push(homePath, outside);
    const client = supervisor((request) => ({
      version: 1,
      ok: true,
      operationId: request.operationId,
      result: [],
    }));
    const runtime = await initializeGatewayTerminalRuntime({
      mode: "supervised",
      nodeEnv: "test",
      homePath,
      supervisor: client,
    });

    await expect(runtime?.createShell({
      displayName: "calm-otter",
      cwd: outside,
    })).rejects.toThrow("terminal_cwd_invalid");
    expect(client.request).toHaveBeenCalledTimes(1);
  });
});
