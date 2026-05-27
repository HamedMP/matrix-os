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

export interface TestGatewayOptions {
  authToken?: string;
  config?: Record<string, unknown>;
  spawnFn?: SpawnFn;
}

export async function startTestGateway(
  options: TestGatewayOptions = {},
): Promise<TestGateway> {
  const homePath = resolve(mkdtempSync(join(tmpdir(), "e2e-gateway-")));
  cpSync(TEMPLATE_DIR, homePath, { recursive: true });

  // Ensure required directories
  mkdirSync(join(homePath, "system", "logs"), { recursive: true });
  mkdirSync(join(homePath, "system", "conversations"), { recursive: true });
  mkdirSync(join(homePath, "system", "plugins"), { recursive: true });

  // Write custom config if provided
  if (options.config) {
    writeFileSync(
      join(homePath, "system", "config.json"),
      JSON.stringify(options.config, null, 2),
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

  const gateway = await createGateway({ homePath, port, spawnFn: options.spawnFn });

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
      }
    },
  };
}
