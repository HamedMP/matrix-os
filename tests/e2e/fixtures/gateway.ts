import { mkdtempSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createGateway } from "../../../packages/gateway/src/server.js";

const TEMPLATE_DIR = resolve(__dirname, "../../../home");

export interface TestGateway {
  url: string;
  homePath: string;
  close: () => Promise<void>;
}

let nextPort = 14_000 + Math.floor(Math.random() * 10_000);

function getPort(): number {
  return nextPort++;
}

export interface TestGatewayOptions {
  authToken?: string;
  config?: Record<string, unknown>;
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
  if (options.authToken) {
    process.env.MATRIX_AUTH_TOKEN = options.authToken;
  } else {
    delete process.env.MATRIX_AUTH_TOKEN;
  }

  const gateway = await createGateway({ homePath, port });

  // Restore env
  if (prevToken !== undefined) {
    process.env.MATRIX_AUTH_TOKEN = prevToken;
  } else {
    delete process.env.MATRIX_AUTH_TOKEN;
  }

  return {
    url: `http://localhost:${port}`,
    homePath,
    async close() {
      await gateway.close();
    },
  };
}
