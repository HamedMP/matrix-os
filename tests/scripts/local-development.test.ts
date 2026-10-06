import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { resolveProxyDatabasePath } from "../../packages/proxy/src/db.js";
import {
  createLocalDevelopmentEnv,
  LOCAL_DEVELOPMENT_SERVICES,
  localInfrastructureCommands,
  startLocalDevelopment,
  startLocalInfrastructure,
} from "../../scripts/dev-local.mjs";
import {
  addLocalParityOperator,
  assertFixtureAddressInstalled,
  assertLocalParityContainerOwnership,
  assertLocalParityMachinesAvailable,
  assertOrbStackCapacity,
  assertTcpPortAvailable,
  buildBundle,
  builderSetupScript,
  clerkSecretIsConfigured,
  cleanupAbandonedLocalParityBuilder,
  cleanupLocalParityResources,
  createLocalParityPlan,
  down,
  fetchConfiguredClerkJwtKey,
  fixtureRouterArguments,
  installLocalParitySignalHandlers,
  lastSuccessfullySeededMachineId,
  LOCAL_PARITY_OWNER_LABEL,
  localParityBuilderName,
  localParityLauncherLockArguments,
  platformContainerArguments,
  platformImageBuildArguments,
  pendingLocalParityMachineId,
  qemuRuntimeArguments,
  renderLocalParityCloudInit,
  runtimeProcessIsOwned,
  runtimeProcessPids,
  runAbortableCommand,
  runLocalParityLauncherWithLock,
  startArtifactServer,
  storageTlsProxyArguments,
} from "../../scripts/dev-production-parity.mjs";
import {
  createSmokeCancellation,
  DOCKER_FULL_STACK_SERVICES,
  dockerFullStackCommands,
  installSmokeSignalHandlers,
  smokeDockerFullStack,
} from "../../scripts/dev-stack-smoke.mjs";

const root = resolve(import.meta.dirname, "../..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as Record<string, unknown>;
}

describe("local development contracts", () => {
  it("pins the workspace and native addons to Node 24", () => {
    const pkg = readJson("package.json") as {
      engines: { node: string };
    };
    const workspace = parse(readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8")) as {
      useNodeVersion?: string;
    };

    expect(pkg.engines.node).toBe(">=24 <25");
    expect(workspace.useNodeVersion).toBe("24.18.0");
    expect(readFileSync(resolve(root, ".nvmrc"), "utf8").trim()).toBe("24.18.0");
    expect(readFileSync(resolve(root, "Dockerfile.platform"), "utf8"))
      .toContain("RUN sed -i '/^useNodeVersion:/d' pnpm-workspace.yaml");
    const dockerIgnore = readFileSync(resolve(root, ".dockerignore"), "utf8");
    expect(dockerIgnore).toContain("**/.env*");
    expect(dockerIgnore).toMatch(/^\.amp$/m);
  });

  it("uses pnpm package filters for source dev under the global virtual store", () => {
    const pkg = readJson("package.json") as {
      scripts: Record<string, string>;
    };
    const shellPkg = readJson("shell/package.json") as { scripts: Record<string, string> };

    expect(pkg.scripts.dev).toContain("--filter '@matrix-os/gateway'");
    expect(pkg.scripts.dev).toContain("--filter '@matrix-os/proxy'");
    expect(pkg.scripts.dev).toContain("--filter './shell' dev");
    expect(pkg.scripts.dev).not.toContain("bun run --filter");
    for (const script of [
      "dev:kernel",
      "dev:gateway",
      "dev:shell",
      "dev:mobile-shell",
      "dev:proxy",
      "dev:platform",
    ]) {
      expect(pkg.scripts[script], script).not.toContain("bun run --filter");
    }
    expect(pkg.scripts["dev:shell"]).toContain("@matrix-os/brand");
    expect(pkg.scripts["dev:platform"]).toContain("@matrix-os/brand");
    expect(shellPkg.scripts.dev).toBe("next dev -p ${PORT:-3000}");
  });

  it("makes the production host topology the canonical full-development entry point", () => {
    const pkg = readJson("package.json") as { scripts: Record<string, string> };

    expect(pkg.scripts["dev:infra"]).toBe("pnpm node scripts/dev-local.mjs infra");
    expect(pkg.scripts["dev:infra:stop"]).toBe("pnpm node scripts/dev-local.mjs stop");
    expect(pkg.scripts["dev:source"]).toBe("pnpm node scripts/dev-local.mjs full");
    expect(pkg.scripts["dev:full"]).toBe("pnpm node scripts/dev-production-parity.mjs up");
    expect(pkg.scripts["dev:parity"]).toBe("pnpm node scripts/dev-production-parity.mjs up");
    expect(pkg.scripts["dev:parity:down"]).toBe("pnpm node scripts/dev-production-parity.mjs down");
    expect(pkg.scripts["dev:parity:status"]).toBe("pnpm node scripts/dev-production-parity.mjs status");
    expect(localInfrastructureCommands.start).toEqual([
      "docker",
      "compose",
      "-f",
      "docker-compose.dev.yml",
      "up",
      "--detach",
      "postgres",
      "minio",
    ]);
    expect(localInfrastructureCommands.configureObjectStore.at(-1)).toBe("minio-init");
    expect(localInfrastructureCommands.stop).toEqual([
      "docker",
      "compose",
      "-f",
      "docker-compose.dev.yml",
      "stop",
      "postgres",
      "minio",
    ]);
    expect(localInfrastructureCommands.stopApplicationContainers.slice(-4)).toEqual([
      "stop",
      "dev",
      "proxy",
      "platform",
    ]);
    expect(LOCAL_DEVELOPMENT_SERVICES).toEqual([
      "@matrix-os/gateway",
      "@matrix-os/proxy",
      "@matrix-os/platform",
      "./shell",
    ]);
  });

  it("builds in Rosetta and boots parity in a real QEMU amd64 Ubuntu 24.04 VM", () => {
    const plan = createLocalParityPlan({
      root,
      machineName: "matrix-os-local",
      builderName: "matrix-os-local-builder",
    });

    expect(plan.builderCreate).toContain("4G");
    expect(plan.builderCreate).toContain("amd64");
    expect(plan.builderCreate).toContain("ubuntu:noble");
    expect(plan.buildCommand).toContain("./scripts/build-host-bundle.sh");
    expect(plan.buildCommand).toContain("NODE_OPTIONS=--max-old-space-size=2048");
    expect(plan.buildCommand).toContain("ERL_AFLAGS='+JMsingle true'");
    expect(plan.buildCommand).toContain("MATRIX_LOCAL_PARITY_BUILD=1");
    expect(plan.buildCommand).toContain("MATRIX_ZELLIJ_SMOKE_TIMEOUT_MULTIPLIER=10");
    expect(plan.buildCommand).toContain("pnpm install --frozen-lockfile --network-concurrency=4 --child-concurrency=1");
    expect(plan.buildCommand).not.toContain(`${root}/node_modules`);
    expect(builderSetupScript()).toContain("fallocate -l 8G /matrix-build.swap");
    expect(builderSetupScript()).toContain("swapon /matrix-build.swap");
    const qemuArgs = qemuRuntimeArguments({
      diskPath: "/runtime/disk.qcow2",
      seedPath: "/runtime/cidata.iso",
      logPath: "/runtime/serial.log",
    });
    expect(qemuArgs).toContain("q35,accel=tcg");
    expect(qemuArgs).toContain("user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22,hostfwd=tcp:127.0.0.1:8443-:443");
    expect(qemuArgs).toContain("if=virtio,format=raw,readonly=on,file=/runtime/cidata.iso");
    expect(qemuArgs).not.toContain("-no-reboot");
  });

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
    const launcher = readFileSync(resolve(root, "scripts/dev-production-parity.mjs"), "utf8");
    expect(launcher).toContain("AUTH_SHELL_CLERK_SECRET_KEY: clerkSecret");
    expect(launcher).toContain("CLERK_JWT_KEY: clerkJwtKey");
    expect(launcher).toContain('CUSTOMER_VPS_CLOUD_INIT_PATH: "distro/customer-vps/cloud-init.yaml"');
    expect(launcher).toContain('GOLDEN_SNAPSHOT_BUILDER_CLOUD_INIT_PATH: "distro/customer-vps/golden-snapshot-builder-cloud-init.yaml"');
    expect(launcher).toContain('GOLDEN_SNAPSHOTS_ENABLED: "false"');
    expect(launcher).toContain('PLATFORM_PREVIEW: "true"');
    expect(launcher).toContain("PLATFORM_JWT_SECRET: state.platformJwtSecret");
    expect(launcher).toContain('S3_PUBLIC_ENDPOINT: `https://${guestHostAddress}:${storageTlsPort}`');
    expect(launcher).not.toContain('platformSecret: env.PLATFORM_SECRET');
    expect(launcher).toContain("browser auth will return a bounded unavailable response");
    expect(clerkSecretIsConfigured(`sk_${"test"}_${"a".repeat(24)}`)).toBe(true);
    expect(clerkSecretIsConfigured("placeholder")).toBe(false);
  });

  it("runs the production platform image with its bundled auth shell", () => {
    const publicEnv = {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_local",
      NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/sign-in",
    };
    expect(platformImageBuildArguments(publicEnv, { imageName: "platform:test" })).toEqual([
      "build",
      "--file",
      "Dockerfile.platform",
      "--tag",
      "platform:test",
      "--build-arg",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_local",
      "--build-arg",
      "NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in",
      ".",
    ]);

    const runtimeEnv = {
      CLERK_JWT_KEY: "public-key",
      PLATFORM_DATABASE_URL: "postgresql://host.docker.internal/platform",
    };
    expect(platformContainerArguments(runtimeEnv, {
      containerName: "platform-local",
      imageName: "platform:test",
      hostPort: 9443,
      owner: "/workspace/matrix-os",
    })).toEqual([
      "run",
      "--detach",
      "--name",
      "platform-local",
      "--label",
      `${LOCAL_PARITY_OWNER_LABEL}=/workspace/matrix-os`,
      "--publish",
      "0.0.0.0:9443:8080",
      "--env",
      "CLERK_JWT_KEY",
      "--env",
      "PLATFORM_DATABASE_URL",
      "platform:test",
    ]);
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

  it("reclaims an abandoned builder owned by this checkout", () => {
    let builderExists = true;
    const deleted: string[] = [];
    cleanupAbandonedLocalParityBuilder({
      builderName: "builder-one",
      machineExists: () => builderExists,
      deleteBuilder: (name: string) => {
        deleted.push(name);
        builderExists = false;
      },
    });

    expect(deleted).toEqual(["builder-one"]);
  });

  it("lets parity down remove a stale checkout-owned builder", () => {
    let builderExists = true;
    const deleted: string[] = [];
    cleanupAbandonedLocalParityBuilder({
      builderName: "builder-one",
      machineExists: () => builderExists,
      deleteBuilder: (name: string) => {
        deleted.push(name);
        builderExists = false;
      },
    });

    expect(deleted).toEqual(["builder-one"]);
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

  it("wraps parity up/down in an exec-owned advisory lock", () => {
    expect(localParityLauncherLockArguments("/tmp/parity.lock", "/usr/bin/node", ["launcher.mjs", "up"]))
      .toEqual([
        resolve(root, "scripts/dev-production-parity-lock.py"),
        "/tmp/parity.lock",
        "/usr/bin/node",
        "launcher.mjs",
        "up",
      ]);
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

  it("fails before building when OrbStack's shared memory cap is too small", () => {
    expect(() => assertOrbStackCapacity(() => "2048")).toThrow(
      "orb config set memory_mib 6144",
    );
    expect(() => assertOrbStackCapacity(() => "6144")).not.toThrow();
  });

  it("requires explicitly approved host routing without taking ownership of it", () => {
    expect(() => assertFixtureAddressInstalled(() => false)).toThrow(
      "sudo ifconfig lo0 alias 192.0.2.2 netmask 255.255.255.255",
    );
    expect(() => assertFixtureAddressInstalled(() => true)).not.toThrow();
    const launcher = readFileSync(resolve(root, "scripts/dev-production-parity.mjs"), "utf8");
    expect(launcher).not.toContain('ifconfig", "lo0", "-alias"');
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

  it("renders the actual production cloud-init with only provider metadata adapted locally", () => {
    const template = readFileSync(resolve(root, "distro/customer-vps/cloud-init.yaml"), "utf8");
    const rendered = renderLocalParityCloudInit(template, {
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff112",
      clerkUserId: "user_local",
      handle: "local",
      hostBundleUrl: "http://10.0.2.2:9876/matrix-host-bundle.tar.gz",
      platformUrl: "http://10.0.2.2:9003",
      platformSecret: "platform-secret",
      registrationToken: "registration-token",
      registrationTokenExpiresAt: "2026-09-29T00:00:00.000Z",
      postgresPassword: "postgres-secret",
    });

    expect(rendered).toContain("path: /etc/systemd/system/matrix-gateway.service");
    expect(rendered).toContain("/opt/matrix/user-systemd");
    expect(readFileSync(resolve(root, "distro/customer-vps/systemd-user/matrix-zellij@.service"), "utf8"))
      .toContain("/opt/matrix/terminal-runtime/current/matrix-terminal-user-keeper.mjs %i");
    expect(rendered).toContain("MATRIX_METADATA_INSTANCE_ID_URL=http://10.0.2.2:9876/metadata/instance-id");
    expect(rendered).toContain("MATRIX_METADATA_PUBLIC_IPV4_URL=http://10.0.2.2:9876/metadata/public-ipv4");
    expect(rendered).toContain("NODE_EXTRA_CA_CERTS=/opt/matrix/local-parity-storage-ca.pem");
    expect(rendered).not.toContain("growpart:\n  mode: off\nresize_rootfs: false");
    expect(rendered).not.toMatch(/\{\{[a-zA-Z0-9_]+\}\}/);
    expect(rendered).not.toContain("MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED");

    const localSeed = parse(addLocalParityOperator(
      rendered,
      "ssh-ed25519 AAAA local",
      "-----BEGIN CERTIFICATE-----\nlocal\n-----END CERTIFICATE-----\n",
    )) as {
      bootcmd: string[];
      users: Array<{ name: string }>;
      write_files: Array<{ path: string; content: string }>;
    };
    expect(localSeed.users.map((user) => user.name)).toEqual(["matrix", "matrix-local-operator"]);
    expect(localSeed.bootcmd[0]).toContain("ip address replace 192.0.2.2/32");
    const encodedCertificate = localSeed.write_files.find(
      (file) => file.path === "/opt/matrix/local-parity-storage-ca.pem",
    )?.content;
    expect(Buffer.from(encodedCertificate ?? "", "base64").toString("utf8")).toContain("BEGIN CERTIFICATE");
  });

  it("gives host services deterministic local infrastructure and auth-bypass settings", () => {
    const env = createLocalDevelopmentEnv({ HOME: "/Users/dev", CUSTOM_VALUE: "kept", PORT: "9999" });

    expect(env).toMatchObject({
      CUSTOM_VALUE: "kept",
      MATRIX_HOME: "/Users/dev/matrixos",
      DATABASE_URL: "postgresql://matrixos:matrixos@127.0.0.1:5432/matrixos",
      PLATFORM_DATABASE_URL: "postgresql://matrixos:matrixos@127.0.0.1:5432/matrixos_platform",
      S3_ENDPOINT: "http://127.0.0.1:9100",
      S3_PUBLIC_ENDPOINT: "http://127.0.0.1:9100",
      S3_BUCKET: "matrixos-sync",
      S3_FORCE_PATH_STYLE: "true",
      E2E_TEST_BYPASS: "1",
      NEXT_PUBLIC_E2E_TEST_BYPASS: "1",
      MATRIX_AUTH_ALLOW_INSECURE_DEV: "1",
      MATRIX_BIND_HOST: "127.0.0.1",
      MATRIX_SELF_HOSTED: "1",
    });
    expect(env).not.toHaveProperty("PORT");
  });

  it("falls back to a valid development identity when MATRIX_HANDLE is blank", () => {
    const env = createLocalDevelopmentEnv({ HOME: "/Users/dev", MATRIX_HANDLE: "  " });

    expect(env.MATRIX_HANDLE).toBe("dev");
  });

  it("waits for long-running infrastructure before idempotent object-store setup", async () => {
    const events: string[] = [];
    const controller = new AbortController();

    await startLocalInfrastructure({
      cancellationSignal: controller.signal,
      runCommand: async (_command: string, args: string[]) => {
        events.push(args.at(-1) ?? "");
      },
      postgresReady: async () => {
        events.push("postgres-ready");
        return true;
      },
      waitForHttp: async () => {
        events.push("object-storage-ready");
      },
      log: () => undefined,
    });

    expect(events).toEqual([
      "minio",
      "object-storage-ready",
      "postgres-ready",
      "minio-alias",
      "minio-init",
    ]);
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

  it("owns process groups so watcher grandchildren cannot outlive a failed startup", () => {
    const orchestrator = readFileSync(resolve(root, "scripts/dev-local.mjs"), "utf8");

    expect(orchestrator).toContain('detached: process.platform !== "win32"');
    expect(orchestrator).toContain("process.kill(-child.pid, signal)");
    expect(orchestrator).toContain("spawn(process.execPath, service.args");
    expect(orchestrator).not.toContain('spawn("pnpm", ["--filter", service');
  });

  it("keeps the source proxy database usable without Docker-only directories", () => {
    expect(resolveProxyDatabasePath({})).toBe(":memory:");
    expect(resolveProxyDatabasePath({ PROXY_DB_PATH: "/data/proxy.db" })).toBe("/data/proxy.db");
  });

  it("wires Docker full-stack services to their documented environment source", () => {
    const compose = parse(readFileSync(resolve(root, "docker-compose.dev.yml"), "utf8")) as {
      services: Record<string, {
        depends_on?: Record<string, unknown>;
        env_file?: string[];
        environment?: string[];
        healthcheck?: { disable?: boolean; start_period?: string };
      }>;
    };
    const environment = (service: string) => compose.services[service]?.environment ?? [];

    expect(environment("dev")).not.toContain("ANTHROPIC_API_KEY=");
    expect(compose.services.dev.env_file).toEqual([{ path: ".env.docker", required: false }]);
    expect(compose.services.postgres.ports).toContain("127.0.0.1:5432:5432");
    expect(compose.services.minio.ports).toEqual([
      "127.0.0.1:9100:9000",
      "127.0.0.1:9101:9001",
    ]);
    expect(compose.services.proxy.env_file).toBeUndefined();
    expect(environment("proxy")).toContain("ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}");
    expect(environment("platform")).toContain(
      "PLATFORM_DATABASE_URL=postgresql://matrixos:matrixos@postgres:5432/matrixos_platform",
    );
    expect(environment("platform").some((value) => value.startsWith("PLATFORM_DB_PATH="))).toBe(false);
    expect(compose.services.platform.depends_on).toHaveProperty("postgres");
    expect(compose.services.dev.healthcheck?.start_period).toBe("5m");
    expect(compose.services.conduit).toBeUndefined();
    const pkg = readJson("package.json") as { scripts: Record<string, string> };
    expect(pkg.scripts["docker:prepare"]).toBe("docker volume create matrixos-ai-auth");
    for (const script of ["docker", "docker:full", "docker:all", "docker:multi"]) {
      expect(pkg.scripts[script], script).toMatch(/^bun run docker:prepare && /);
    }
    expect(pkg.scripts["docker:full"]).toContain("--env-file .env.docker");
  });

  it("provides a bounded full-stack smoke with non-destructive cleanup", () => {
    expect(DOCKER_FULL_STACK_SERVICES).toEqual([
      "shell",
      "gateway",
      "proxy",
      "platform",
      "postgres",
      "minio",
    ]);
    expect(dockerFullStackCommands.start).toContain("up");
    expect(dockerFullStackCommands.prepare).toEqual([
      "docker",
      "volume",
      "create",
      "matrixos-ai-auth",
    ]);
    expect(dockerFullStackCommands.cleanup).toContain("down");
    expect(dockerFullStackCommands.cleanup).not.toContain("-v");
  });

  it("cancels health polling without allowing later signals to interrupt cleanup", () => {
    const killedWith: NodeJS.Signals[] = [];
    let cleanupInProgress = false;
    const cancellation = createSmokeCancellation(
      () => ({ kill: (signal: NodeJS.Signals) => killedWith.push(signal) }),
      () => cleanupInProgress,
    );

    cancellation.handleSignal("SIGINT");
    expect(cancellation.signal.aborted).toBe(true);
    expect(killedWith).toEqual(["SIGINT"]);

    cleanupInProgress = true;
    cancellation.handleSignal("SIGTERM");
    expect(killedWith).toEqual(["SIGINT"]);
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
