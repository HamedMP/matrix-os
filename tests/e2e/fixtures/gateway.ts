import { mkdtempSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createGateway } from "../../../packages/gateway/src/server.js";
import type { SpawnFn } from "../../../packages/gateway/src/dispatcher.js";

const TEMPLATE_DIR = resolve(__dirname, "../../../home");

export interface TestGateway {
  url: string;
  homePath: string;
  request: (path: string, init?: RequestInit) => ReturnType<Awaited<ReturnType<typeof createGateway>>["app"]["request"]>;
  close: () => Promise<void>;
}

let nextPort = 14_000 + Math.floor(Math.random() * 10_000);
let insecureDevGatewayCount = 0;
let previousInsecureDevValue: string | undefined;

function getPort(): number {
  return nextPort++;
}

function releaseInsecureDevAuth(): void {
  insecureDevGatewayCount = Math.max(0, insecureDevGatewayCount - 1);
  if (insecureDevGatewayCount === 0) {
    if (previousInsecureDevValue !== undefined) {
      process.env.MATRIX_AUTH_ALLOW_INSECURE_DEV = previousInsecureDevValue;
    } else {
      delete process.env.MATRIX_AUTH_ALLOW_INSECURE_DEV;
    }
    previousInsecureDevValue = undefined;
  }
}

export interface TestGatewayOptions {
  authToken?: string;
  config?: Record<string, unknown>;
  spawnFn?: SpawnFn;
  /** Synthetic owner key for an injected kernel only; never enables real inference. */
  mockOwnerCredentials?: boolean;
  runningVersion?: string;
}

export async function startTestGateway(
  options: TestGatewayOptions = {},
): Promise<TestGateway> {
  if (options.mockOwnerCredentials && !options.spawnFn) {
    throw new Error("Mock owner credentials require an injected kernel");
  }
  const kernelConfig = options.config?.kernel;
  const config = options.mockOwnerCredentials ? {
    ...options.config,
    kernel: {
      ...(kernelConfig && typeof kernelConfig === "object" && !Array.isArray(kernelConfig) ? kernelConfig : {}),
      anthropicApiKey: "synthetic-e2e-owner-key",
    },
  } : options.config;
  const homePath = resolve(mkdtempSync(join(tmpdir(), "e2e-gateway-")));
  cpSync(TEMPLATE_DIR, homePath, { recursive: true });

  // Ensure required directories
  mkdirSync(join(homePath, "system", "logs"), { recursive: true });
  mkdirSync(join(homePath, "system", "conversations"), { recursive: true });
  mkdirSync(join(homePath, "system", "plugins"), { recursive: true });

  // Write custom config if provided
  if (config) {
    writeFileSync(
      join(homePath, "system", "config.json"),
      JSON.stringify(config, null, 2),
    );
  }

  // Init git (needed by dispatcher)
  try {
    execFileSync("git", ["init"], { cwd: homePath, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: homePath, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "init"], {
      cwd: homePath,
      stdio: "ignore",
    });
  } catch {
    // git not critical for all tests
  }

  const port = getPort();

  // Set auth token if provided
  const prevToken = process.env.MATRIX_AUTH_TOKEN;
  const usesInsecureDevAuth = !options.authToken;
  if (options.authToken) {
    process.env.MATRIX_AUTH_TOKEN = options.authToken;
  } else {
    delete process.env.MATRIX_AUTH_TOKEN;
    if (insecureDevGatewayCount === 0) {
      previousInsecureDevValue = process.env.MATRIX_AUTH_ALLOW_INSECURE_DEV;
      process.env.MATRIX_AUTH_ALLOW_INSECURE_DEV = "1";
    }
    insecureDevGatewayCount += 1;
  }

  let gateway: Awaited<ReturnType<typeof createGateway>>;
  try {
    gateway = await createGateway({
      homePath,
      port,
      spawnFn: options.spawnFn,
      runningVersion: options.runningVersion,
    });
  } catch (error) {
    if (usesInsecureDevAuth) {
      releaseInsecureDevAuth();
    }
    if (prevToken !== undefined) {
      process.env.MATRIX_AUTH_TOKEN = prevToken;
    } else {
      delete process.env.MATRIX_AUTH_TOKEN;
    }
    throw error;
  }

  // Restore env
  if (prevToken !== undefined) {
    process.env.MATRIX_AUTH_TOKEN = prevToken;
  } else {
    delete process.env.MATRIX_AUTH_TOKEN;
  }

  return {
    url: `http://localhost:${port}`,
    homePath,
    request(path, init) {
      return gateway.app.request(path, init);
    },
    async close() {
      try {
        await gateway.close();
      } finally {
        if (usesInsecureDevAuth) {
          releaseInsecureDevAuth();
        }
      }
    },
  };
}
