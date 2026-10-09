import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { startLocalDevelopment } from "../../scripts/dev-local.mjs";
import {
  assertParityTlsCertificate,
  assertLocalParityContainerOwnership,
  assertLocalParityMachinesAvailable,
  assertTcpPortAvailable,
  buildBundle,
  clerkSecretIsConfigured,
  cleanupLocalParityResources,
  down,
  fetchConfiguredClerkJwtKey,
  fixtureRouterArguments,
  installLocalParitySignalHandlers,
  lastSuccessfullySeededMachineId,
  LOCAL_PARITY_OWNER_LABEL,
  localParityBuilderName,
  localParityLauncherLockArguments,
  platformEnvironment,
  publicBuildEnvironment,
  pendingLocalParityMachineId,
  runtimeProcessIsOwned,
  runtimeProcessPids,
  runAbortableCommand,
  runLocalParityLauncherWithLock,
  startArtifactServer,
  storageTlsProxyArguments,
} from "../../scripts/dev-production-parity.mjs";
import { loadPlatformCollaborationConfig } from "../../packages/platform/src/collaboration/wiring.js";
import { loadTicketSigningKeyring } from "../../packages/platform/src/collaboration/ticket-issuer.js";

it("supplies valid local collaboration configuration with retained environment-specific signing", () => {
  const state = { platformSecret: "saved-secret", platformJwtSecret: "saved-jwt" };
  const env = platformEnvironment(state, "jwt-key");
  expect(loadPlatformCollaborationConfig(env)?.relayOrigin).toBe("https://app.localhost:9445");
  expect(loadPlatformCollaborationConfig(env)?.allowedOrigins).toEqual(["https://app.localhost:9445"]);
  expect(publicBuildEnvironment().NEXT_PUBLIC_MATRIX_APP_URL).toBe("https://app.localhost:9445");
  expect(env.NEXT_PUBLIC_MATRIX_APP_URL).toBe("https://app.localhost:9445");
  expect(loadTicketSigningKeyring(env)).not.toBeNull();
  expect(env.MATRIX_COLLABORATION_TICKET_KEYS).toBe(platformEnvironment(state, "other-jwt").MATRIX_COLLABORATION_TICKET_KEYS);
  expect(env.MATRIX_COLLABORATION_TICKET_KEYS).not.toBe(platformEnvironment({ ...state, platformSecret: "other-environment" }, "jwt-key").MATRIX_COLLABORATION_TICKET_KEYS);
  expect(storageTlsProxyArguments().at(-1)).toContain("TCP:host.docker.internal:9100");
  expect(storageTlsProxyArguments({ port: 9445, targetPort: 9003 }).at(-1)).toContain("OPENSSL-LISTEN:9445");
  expect(storageTlsProxyArguments({ port: 9445, targetPort: 9003 }).at(-1)).toContain("TCP:host.docker.internal:9003");
});

it("requires migration of a retained IP-only certificate without modifying its key", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "parity-tls-"));
  const key = resolve(directory, "key.pem");
  const certificate = resolve(directory, "certificate.pem");
  try {
    const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-days", "1", "-subj", "/CN=local", "-addext", "subjectAltName=IP:10.0.2.2",
      "-keyout", key, "-out", certificate]);
    expect(generated.status).toBe(0);
    const retainedKey = readFileSync(key);
    expect(() => assertParityTlsCertificate(certificate)).toThrow(/SANs.*manually/);
    const migrated = spawnSync("openssl", ["req", "-x509", "-key", key, "-days", "1",
      "-subj", "/CN=local", "-addext", "subjectAltName=IP:10.0.2.2,DNS:app.localhost,DNS:localhost",
      "-out", certificate]);
    expect(migrated.status).toBe(0);
    expect(() => assertParityTlsCertificate(certificate)).not.toThrow();
    expect(readFileSync(key)).toEqual(retainedKey);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
import {
  createSmokeCancellation,
  dockerFullStackCommands,
  installSmokeSignalHandlers,
  smokeDockerFullStack,
} from "../../scripts/dev-stack-smoke.mjs";

describe("local development contracts", () => {
  it("uses the configured Clerk instance JWKS for local token verification", async () => {
    const publishableKey = `pk_test_${Buffer.from("modest-bengal-5417.clerk.accounts.dev$").toString("base64url")}`;
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrls.push(String(input));
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({
        keys: [{
          kty: "RSA",
          n: "1-YGirB74c53ncGxhz0ui4tbLiQZUw66OAjKujqcHgY0pAAK9pvs7WdSg4O8S2cfmB4eslAUs7YHLuQNaa6wZ9aGlTkz8018eGxtvpkJbKitswhPzC70mqpCoKYG5HgOnN89BbpsUbFP-c_TiniRQQUe_MQ5VxZAemDCEot0-LBci_xBFwJ-pCaZ9qb_h4e8JOOpzkAAkx7HDq842qv7WIbY95xq2P3SQol2G8wau_E9o0PnizzoYn6823UOlkBa7FREyFteqK-EPnOrhJBZjk7dY_8_U8tpFZ_r0IPuYfHU6oxedkkwLaASVgOofGXchVTsszfUd6b8gIczNiFbNw",
          e: "AQAB",
        }],
      });
    };

    await expect(fetchConfiguredClerkJwtKey(publishableKey, fetchImpl)).resolves.toMatch(
      /^-----BEGIN PUBLIC KEY-----/,
    );
    const productionKey = `pk_live_${Buffer.from("clerk.matrix-os.com$").toString("base64url")}`;
    await expect(fetchConfiguredClerkJwtKey(productionKey, fetchImpl)).resolves.toMatch(
      /^-----BEGIN PUBLIC KEY-----/,
    );
    expect(requestedUrls).toEqual([
      "https://modest-bengal-5417.clerk.accounts.dev/.well-known/jwks.json",
      "https://clerk.matrix-os.com/.well-known/jwks.json",
    ]);
    await expect(fetchConfiguredClerkJwtKey("pk_test_not-base64", fetchImpl))
      .rejects.toThrow("Invalid Clerk publishable key");
    expect(clerkSecretIsConfigured(`sk_${"test"}_${"a".repeat(24)}`)).toBe(true);
    expect(clerkSecretIsConfigured("placeholder")).toBe(false);
  });

  it("limits parity bridge containers to this checkout and loopback storage", () => {
    expect(fixtureRouterArguments({ name: "router", owner: "/workspace/one" })).toContain(
      `${LOCAL_PARITY_OWNER_LABEL}=/workspace/one`,
    );
    expect(storageTlsProxyArguments({
      name: "storage",
      owner: "/workspace/one",
      port: 9444,
      tlsDirectory: "/tls",
    })).toEqual(expect.arrayContaining([
      `${LOCAL_PARITY_OWNER_LABEL}=/workspace/one`,
      "127.0.0.1:9444:9444",
      "/tls:/tls:ro",
    ]));
    expect(() => assertLocalParityContainerOwnership("storage", "/workspace/two", "/workspace/one"))
      .toThrow("storage belongs to another checkout");
    expect(() => assertLocalParityContainerOwnership("storage", "/workspace/one", "/workspace/one"))
      .not.toThrow();
  });

  it("refuses to replace an existing parity runtime or builder", () => {
    expect(() => assertLocalParityMachinesAvailable({
      builderName: "matrix-os-local-builder",
      machineExists: () => false,
      runtimeExists: () => true,
    })).toThrow("matrix-os-local QEMU runtime already exists");

    expect(() => assertLocalParityMachinesAvailable({
      builderName: "matrix-os-local-builder",
      machineExists: (name: string) => name === "matrix-os-local-builder",
      runtimeExists: () => false,
      containerExists: () => false,
    })).toThrow("matrix-os-local-builder already exists");

    expect(() => assertLocalParityMachinesAvailable({
      builderName: "matrix-os-local-builder",
      machineExists: () => false,
      runtimeExists: () => false,
      containerExists: (name: string) => name === "matrix-os-parity-platform",
    })).toThrow("matrix-os-parity-platform already exists");

    expect(runtimeProcessIsOwned({
      pid: 123,
      diskPath: "/runtime/disk.qcow2",
      processCommand: () => "qemu-system-x86_64 -drive file=/runtime/disk.qcow2",
    })).toBe(true);
    expect(runtimeProcessIsOwned({
      pid: 123,
      diskPath: "/runtime/disk.qcow2",
      processCommand: () => "unrelated-process",
    })).toBe(false);
    expect(runtimeProcessPids({
      diskPath: "/runtime/disk.qcow2",
      processList: () => [
        "  123 qemu-system-x86_64 -drive file=/runtime/disk.qcow2",
        "  456 qemu-system-x86_64 -drive file=/other/disk.qcow2",
        "  789 rg /runtime/disk.qcow2",
      ].join("\n"),
    })).toEqual([123]);
  });

  it("uses a stable checkout-owned builder name", () => {
    const first = localParityBuilderName("/workspace/one", "matrix-os-local");
    expect(first).toBe(localParityBuilderName("/workspace/one", "matrix-os-local"));
    expect(first).not.toBe(localParityBuilderName("/workspace/two", "matrix-os-local"));
    expect(first).toMatch(/^matrix-os-local-builder-[a-f0-9]{12}$/);
  });

  it("continues parity teardown when abandoned builder cleanup fails", async () => {
    const events: string[] = [];
    const failure = await down({
      cleanupBuilder: () => {
        events.push("builder");
        throw new Error("builder deletion failed");
      },
      cleanupResources: async () => {
        events.push("runtime");
        throw new Error("runtime cleanup failed");
      },
    }).catch((error: unknown) => error);

    expect(events).toEqual(["builder", "runtime"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      new Error("builder deletion failed"),
      new Error("runtime cleanup failed"),
    ]);

    await expect(down({
      cleanupBuilder: () => undefined,
      cleanupResources: async () => undefined,
    })).resolves.toBeUndefined();
  });

  it("rejects a contending launcher and recovers immediately after abrupt owner death", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "matrix-parity-lock-"));
    const lockPath = resolve(directory, "launcher.lock");
    const readyPath = resolve(directory, "ready");
    const rejectedPath = resolve(directory, "rejected");
    const recoveredPath = resolve(directory, "recovered");
    const holder = spawn("python3", localParityLauncherLockArguments(lockPath, process.execPath, [
      "--eval",
      `require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, "ready"); setTimeout(() => {}, 30000)`,
    ]), { stdio: "ignore" });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(readyPath) && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      expect(existsSync(readyPath)).toBe(true);

      await expect(runLocalParityLauncherWithLock({
        lockPath,
        command: process.execPath,
        args: ["--eval", `require("node:fs").writeFileSync(${JSON.stringify(rejectedPath)}, "ran")`],
      })).rejects.toThrow("Local parity launcher failed");
      expect(existsSync(rejectedPath)).toBe(false);

      holder.kill("SIGKILL");
      await new Promise((resolvePromise) => holder.once("close", resolvePromise));
      await runLocalParityLauncherWithLock({
        lockPath,
        command: process.execPath,
        args: ["--eval", `require("node:fs").writeFileSync(${JSON.stringify(recoveredPath)}, "ran")`],
      });
      expect(existsSync(recoveredPath)).toBe(true);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill("SIGKILL");
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("deletes its invocation-owned builder when interrupted during the bundle build", async () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const signalTarget = {
      on(signal: NodeJS.Signals, listener: () => void) {
        listeners.set(signal, listener);
      },
      off(signal: NodeJS.Signals, listener: () => void) {
        if (listeners.get(signal) === listener) listeners.delete(signal);
      },
    };
    const controller = new AbortController();
    const removeSignalHandlers = installLocalParitySignalHandlers(signalTarget, controller);
    const commands: string[][] = [];
    let builderExists = false;

    await expect(buildBundle({
      builderCreate: ["orb", "create", "local-builder"],
      buildCommand: "build bundle",
    }, {
      builderName: "local-builder",
      machineExists: () => builderExists,
      reuseBundle: false,
      signal: controller.signal,
      runCommand: async (command: string, args: string[]) => {
        commands.push([command, ...args]);
        if (args[0] === "create") builderExists = true;
        if (args.includes("root")) listeners.get("SIGINT")?.();
        if (args[0] === "delete") builderExists = false;
      },
    })).rejects.toThrow("Interrupted by SIGINT");
    removeSignalHandlers();

    expect(commands[0]).toEqual(["orb", "create", "local-builder"]);
    expect(commands.at(-1)).toEqual(["orb", "delete", "--force", "local-builder"]);
    expect(commands.some((command) => command.includes("build bundle"))).toBe(false);
    expect(builderExists).toBe(false);
    expect(listeners.size).toBe(0);
  });

  it("delivers a real process signal while an abortable child command is running", async () => {
    const script = [
      `import { runAbortableCommand } from ${JSON.stringify(new URL("../../scripts/dev-production-parity.mjs", import.meta.url).href)};`,
      "const controller = new AbortController();",
      "process.once('SIGTERM', () => controller.abort(new Error('interrupted')));",
      "const signaler = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);",
      "try {",
      "  await runAbortableCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { signal: controller.signal });",
      "} catch (error) {",
      "  console.log(error.message);",
      "} finally {",
      "  clearTimeout(signaler);",
      "  console.log('cleanup-reached');",
      "}",
    ].join("\n");
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });

    expect(result).toEqual({ code: 0, signal: null });
    expect(stderr).toBe("");
    expect(stdout).toContain("interrupted");
    expect(stdout).toContain("cleanup-reached");
  });

  it("cleans an invocation-owned builder left by a failed create", async () => {
    const commands: string[][] = [];
    let builderExists = false;
    await expect(buildBundle({
      builderCreate: ["orb", "create", "unique-builder"],
      buildCommand: "build bundle",
    }, {
      builderName: "unique-builder",
      machineExists: () => builderExists,
      reuseBundle: false,
      runCommand: async (command: string, args: string[]) => {
        commands.push([command, ...args]);
        if (args[0] === "create") {
          builderExists = true;
          throw new Error("create acknowledgement failed");
        }
        if (args[0] === "delete") builderExists = false;
      },
    })).rejects.toThrow("create acknowledgement failed");

    expect(commands).toEqual([
      ["orb", "create", "unique-builder"],
      ["orb", "delete", "--force", "unique-builder"],
    ]);
    expect(builderExists).toBe(false);
  });

  it("cleans all owned resources after failure but preserves a live runtime disk", async () => {
    const events: string[] = [];
    await cleanupLocalParityResources({
      stopRuntime: async () => events.push("runtime"),
      stopContainers: [
        () => events.push("router"),
        () => events.push("storage"),
        () => events.push("platform"),
      ],
      removeRuntime: () => events.push("files"),
    });
    expect(events).toEqual(["runtime", "router", "storage", "platform", "files"]);

    events.length = 0;
    await expect(cleanupLocalParityResources({
      stopRuntime: async () => { throw new Error("still running"); },
      stopContainers: [() => events.push("router"), () => events.push("storage")],
      removeRuntime: () => events.push("files"),
    })).rejects.toThrow("Failed to clean up local parity resources safely");
    expect(events).toEqual(["router", "storage"]);
  });

  it("keeps the last successfully seeded machine across failed candidates", () => {
    expect(lastSuccessfullySeededMachineId({ machineId: "machine-a" })).toBeUndefined();
    expect(pendingLocalParityMachineId({ machineId: "machine-a" })).toBe("machine-a");
    const interrupted = JSON.parse(JSON.stringify({
      stateVersion: 2,
      machineId: "machine-b",
      previousMachineId: "machine-a",
      seededMachineId: "machine-a",
    }));
    expect(lastSuccessfullySeededMachineId(interrupted)).toBe("machine-a");
    expect(pendingLocalParityMachineId(interrupted)).toBe("machine-b");
    const failedBeforeSecondSeed = JSON.parse(JSON.stringify({
      ...interrupted,
      machineId: pendingLocalParityMachineId(interrupted) ?? "machine-c",
    }));
    expect(pendingLocalParityMachineId(failedBeforeSecondSeed)).toBe("machine-b");
    expect(lastSuccessfullySeededMachineId({
      stateVersion: 2,
      machineId: "machine-b",
      seededMachineId: "machine-b",
    })).toBe("machine-b");

    const firstFailedLaunch = JSON.parse(JSON.stringify({
      stateVersion: 2,
      machineId: "machine-first-candidate",
      seededMachineId: null,
    }));
    expect(lastSuccessfullySeededMachineId(firstFailedLaunch)).toBeUndefined();
    expect(pendingLocalParityMachineId(firstFailedLaunch)).toBe("machine-first-candidate");
  });

  it("rejects an artifact-server bind race through the startup promise", async () => {
    const { createServer } = await import("node:net");
    const listener = createServer();
    await new Promise<void>((resolvePromise) => listener.listen(0, "127.0.0.1", resolvePromise));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");

    try {
      await expect(startArtifactServer({ hetznerServerId: 424242 }, {
        port: address.port,
        host: "127.0.0.1",
      })).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => listener.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      }));
    }
  });

  it("rejects an occupied readiness port rather than accepting a stale service", async () => {
    const { createServer } = await import("node:net");
    const listener = createServer();
    await new Promise<void>((resolvePromise) => listener.listen(0, "127.0.0.1", resolvePromise));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");

    try {
      await expect(assertTcpPortAvailable(address.port, "127.0.0.1"))
        .rejects.toThrow(`TCP port ${address.port} is already accepting loopback connections`);
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => listener.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      }));
    }
  });

  it("stops every source watcher when readiness fails", async () => {
    const stoppedWith: NodeJS.Signals[] = [];
    const events: string[] = [];

    await expect(startLocalDevelopment({
      startInfrastructure: async () => undefined,
      runCommand: async () => undefined,
      startServices: () => ({
        exited: new Promise<void>(() => undefined),
        stop: async (signal: NodeJS.Signals) => {
          stoppedWith.push(signal);
          await new Promise((resolve) => setTimeout(resolve, 10));
          events.push("watchers-stopped");
        },
      }),
      waitForHttp: async (_checks: unknown, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        throw new Error("port collision");
      },
      log: () => undefined,
    }).catch((error: unknown) => {
      events.push("rejected");
      throw error;
    })).rejects.toThrow("port collision");

    expect(stoppedWith).toEqual(["SIGTERM"]);
    expect(events).toEqual(["watchers-stopped", "rejected"]);
  });

  it("identifies a source service that exits cleanly during startup", async () => {
    await expect(startLocalDevelopment({
      startInfrastructure: async () => undefined,
      runCommand: async () => undefined,
      startServices: () => ({
        exited: Promise.resolve({ name: "proxy", pid: 123, code: 0, signal: null }),
        stop: async () => undefined,
      }),
      waitForHttp: async () => new Promise<void>(() => undefined),
      log: () => undefined,
    })).rejects.toThrow("proxy (pid 123) stopped before local development became ready");
  });

  it("cancels during health polling, cleans up once, and removes signal listeners", async () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const signalTarget = {
      on(signal: NodeJS.Signals, listener: () => void) {
        listeners.set(signal, listener);
      },
      off(signal: NodeJS.Signals, listener: () => void) {
        if (listeners.get(signal) === listener) listeners.delete(signal);
      },
    };
    let cleanupInProgress = false;
    const cancellation = createSmokeCancellation(
      () => undefined,
      () => cleanupInProgress,
    );
    const removeSignalHandlers = installSmokeSignalHandlers(signalTarget, cancellation);
    const commands: string[][] = [];
    let pollingStarted!: () => void;
    const enteredPolling = new Promise<void>((resolve) => {
      pollingStarted = resolve;
    });

    const smoke = smokeDockerFullStack({
      cancellationSignal: cancellation.signal,
      accessEnv: async () => undefined,
      runCommand: async (command: string, args: string[]) => {
        commands.push([command, ...args]);
        if (args.includes("down")) cleanupInProgress = true;
      },
      waitForServices: async (signal: AbortSignal) => {
        pollingStarted();
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      verifyDatabase: async () => undefined,
      log: () => undefined,
    }).finally(removeSignalHandlers);

    await enteredPolling;
    listeners.get("SIGINT")?.();
    listeners.get("SIGTERM")?.();

    await expect(smoke).rejects.toThrow("smoke canceled by SIGINT");
    expect(commands.filter((command) => command.includes("down"))).toHaveLength(1);
    expect(commands.at(-1)).toEqual(dockerFullStackCommands.cleanup);
    expect(listeners.size).toBe(0);
  });
});
