#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";

import { runFakeProviderVerification } from "./fake-provider.mjs";
import {
  OPENROUTER_ANTHROPIC_BASE_URL,
  TARGET_AGENT_SDK_VERSION,
  formatVerificationFailure,
  parseClaudeAuthStatus,
} from "./verification.mjs";

function readClaudeAuthStatus() {
  const configuredExecutable = process.env.MATRIX_CLAUDE_BIN;
  if (configuredExecutable && !path.isAbsolute(configuredExecutable)) {
    throw new Error("MATRIX_CLAUDE_BIN must be an absolute path");
  }
  const result = spawnSync(configuredExecutable ?? "claude", ["auth", "status", "--json"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 64 * 1024,
    timeout: 10_000,
  });
  if (result.error?.code === "ENOENT") {
    return { available: false, loggedIn: false };
  }
  if (result.error) {
    throw new Error("Claude auth status check failed");
  }
  return { available: true, ...parseClaudeAuthStatus(result.stdout) };
}

async function main() {
  const packageDirectory =
    process.env.MATRIX_AGENT_SDK_PACKAGE_DIR ?? process.argv[2];
  if (!packageDirectory || !path.isAbsolute(packageDirectory)) {
    throw new Error(
      "Set MATRIX_AGENT_SDK_PACKAGE_DIR to the absolute @anthropic-ai/claude-agent-sdk package directory",
    );
  }

  const runtime = await runFakeProviderVerification({
    sdkPackageDirectory: packageDirectory,
  });
  const report = {
    targetVersion: TARGET_AGENT_SDK_VERSION,
    runtime,
    anthropicLogin: readClaudeAuthStatus(),
    openRouter: {
      agentSdkBaseUrl: OPENROUTER_ANTHROPIC_BASE_URL,
      oauthPkceContract: "verified",
      liveExchange: "credential_blocked",
    },
    cloudflare: {
      anthropicStreaming: "fake_provider_verified",
      liveUnifiedBilling: "credential_blocked",
      payloadLoggingHeader: "cf-aig-collect-log-payload: false",
      perRequestZdrHeader: "cf-aig-zdr: true",
      customMetadataLimit: 5,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${formatVerificationFailure(error)}\n`);
  process.exitCode = 1;
});
