const routing = vi.hoisted(() => ({ targets: [] as string[], routes: {} as Record<string, string> }));
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return { ...actual, createConnection(options: import("node:net").NetConnectOpts, listener?: () => void) {
    if ("path" in options) {
      routing.targets.push(options.path);
      return actual.createConnection({ ...options, path: routing.routes[options.path] ?? options.path }, listener);
    }
    return actual.createConnection(options, listener);
  } };
});
import { createServer } from "node:net";
import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { createScopeRuntimeServer } from "../../packages/scope-runtime/src/server.js";
import { SCOPE_RUNTIME_PROFILE } from "../../packages/scope-runtime/src/supervisor.js";
import { createSharedAiRuntime } from "../../packages/gateway/src/collaboration/shared-ai-runtime.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); routing.targets.length = 0; routing.routes = {}; });

it.each([false, true])("absent-host collaboration refuses namespaced legacy fallback before connecting/binding/unlinking (valid config=%s)", async (valid) => {
  const root = await createUnixSocketTempDir(); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const supervisorSocket = join(root, "legacy-supervisor.sock"), brokerSocket = join(root, "legacy-broker.sock");
  const handle = vi.fn(async (request) => ({ version: 1 as const, type: "capability.result" as const, requestId: request.requestId,
    ok: true as const, supervisorVersion: "1.0.0", profile: { ...SCOPE_RUNTIME_PROFILE, executionGeneration: "7" } }));
  const supervisor = createScopeRuntimeServer({ socketPath: supervisorSocket, controller: { handle, close() {} } });
  await supervisor.start(); cleanup.push(() => supervisor.close());
  const broker = createServer(); await new Promise<void>((resolve) => broker.listen(brokerSocket, resolve));
  cleanup.push(() => new Promise<void>((resolve) => broker.close(() => resolve())));
  const before = await stat(brokerSocket);
  vi.stubEnv("MATRIX_SCOPE_RUNTIME_NAMESPACE", "eng432-stage2");
  vi.stubEnv("MATRIX_SCOPE_RUNTIME_APP_ROOT", valid ? "/var/lib/matrix-devstack/eng432-stage2/app" : "/opt/matrix/app");
  vi.stubEnv("MATRIX_HOME", "/var/lib/matrix-devstack/eng432-stage2/home");
  // Real absent-host constructor, real supervisor and live broker sentinels.
  // Only deployment socket locations substitute temporary paths for installed /run paths.
  const options = { homePath: "/var/lib/matrix-devstack/eng432-stage2/home", supervisorSocket, brokerSocket,
    chatScope: { async reconcileExecutionEligibility() {} } } as Parameters<typeof createSharedAiRuntime>[0];
  const outcome = await createSharedAiRuntime(options).catch((error: unknown) => error);
  expect(handle).not.toHaveBeenCalled();
  expect(outcome).toBeInstanceOf(Error);
  expect((await stat(brokerSocket)).ino).toBe(before.ino);
  expect((await stat(supervisorSocket)).isSocket()).toBe(true);
});


it("actual absent-host default selection connects only to the resolved namespace and preserves live legacy sentinels", async () => {
  const root = await createUnixSocketTempDir(); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const legacySupervisor = join(root, "legacy-supervisor.sock"), legacyBroker = join(root, "legacy-broker.sock"), ownSupervisor = join(root, "own-supervisor.sock");
  const legacyHandle = vi.fn(async (request) => ({ version: 1 as const, type: "capability.result" as const, requestId: request.requestId,
    ok: true as const, supervisorVersion: "1.0.0", profile: { ...SCOPE_RUNTIME_PROFILE, executionGeneration: "7" } }));
  const legacy = createScopeRuntimeServer({ socketPath: legacySupervisor, controller: { handle: legacyHandle, close() {} } });
  await legacy.start(); cleanup.push(() => legacy.close());
  const ownHandle = vi.fn(async (request) => ({ version: 1 as const, type: "capability.result" as const, requestId: request.requestId,
    ok: false as const, error: "runtime_unavailable" as const }));
  const own = createScopeRuntimeServer({ socketPath: ownSupervisor, controller: { handle: ownHandle, close() {} } });
  await own.start(); cleanup.push(() => own.close());
  const broker = createServer(); await new Promise<void>((resolve) => broker.listen(legacyBroker, resolve));
  cleanup.push(() => new Promise<void>((resolve) => broker.close(() => resolve())));
  const before = await stat(legacyBroker);
  const namespace = "eng432-stage2", configured = `/run/matrix-devstack/${namespace}/scope-runtime/supervisor.sock`;
  // Record the production address selection, then connect real Unix sockets at owned temporary substitutes.
  routing.routes[configured] = ownSupervisor;
  routing.routes["/run/matrix-scope-runtime/supervisor.sock"] = legacySupervisor;
  vi.stubEnv("MATRIX_SCOPE_RUNTIME_NAMESPACE", namespace);
  vi.stubEnv("MATRIX_SCOPE_RUNTIME_APP_ROOT", `/var/lib/matrix-devstack/${namespace}/app`);
  vi.stubEnv("MATRIX_HOME", `/var/lib/matrix-devstack/${namespace}/home`);
  const runtime = await createSharedAiRuntime({ homePath: `/var/lib/matrix-devstack/${namespace}/home`,
    chatScope: { async reconcileExecutionEligibility() {} } } as Parameters<typeof createSharedAiRuntime>[0]);
  cleanup.push(() => runtime.shutdown());
  expect(runtime.available).toBe(false);
  expect(routing.targets.length).toBeGreaterThan(0);
  expect(routing.targets.every((target) => target === configured)).toBe(true);
  expect(ownHandle).toHaveBeenCalled();
  expect(legacyHandle).not.toHaveBeenCalled();
  expect((await stat(legacyBroker)).ino).toBe(before.ino);
});
