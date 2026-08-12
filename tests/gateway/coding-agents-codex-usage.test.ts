import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexUsageProbe,
  normalizeCodexRateLimits,
} from "../../packages/gateway/src/coding-agents/codex-usage-probe.js";

const observedAt = new Date("2026-08-10T12:00:00.000Z");
const fixture = {
  rateLimits: {
    limitId: "codex",
    limitName: "Codex",
    primary: {
      usedPercent: 28,
      windowDurationMins: 300,
      resetsAt: 1_786_348_800,
    },
    secondary: {
      usedPercent: 59,
      windowDurationMins: 10_080,
      resetsAt: 1_786_752_000,
    },
    credits: {
      hasCredits: true,
      unlimited: false,
      balance: "12.50",
    },
    individualLimit: null,
    spendControlReached: false,
    planType: "plus",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: null,
  rateLimitResetCredits: null,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("Codex provider usage", () => {
  it("normalizes exact provider windows, reset times, and credits", () => {
    const source = normalizeCodexRateLimits(fixture, observedAt);

    expect(source).toEqual({
      id: "openai-chatgpt",
      displayName: "OpenAI / ChatGPT",
      linkedAgentProviderIds: ["codex"],
      state: "available",
      accuracy: "provider_reported",
      windows: [
        {
          id: "primary",
          label: "5-hour window",
          remainingPercent: 72,
          resetsAt: new Date(1_786_348_800 * 1_000).toISOString(),
          windowMinutes: 300,
        },
        {
          id: "secondary",
          label: "7-day window",
          remainingPercent: 41,
          resetsAt: new Date(1_786_752_000 * 1_000).toISOString(),
          windowMinutes: 10_080,
        },
      ],
      credits: { remaining: 12.5, unit: "USD" },
      observedAt: observedAt.toISOString(),
      setupActions: [],
    });
  });

  it.each([
    { rateLimits: { ...fixture.rateLimits, primary: { ...fixture.rateLimits.primary, usedPercent: -1 } } },
    { rateLimits: { ...fixture.rateLimits, primary: { ...fixture.rateLimits.primary, usedPercent: 101 } } },
    { rateLimits: { ...fixture.rateLimits, credits: { ...fixture.rateLimits.credits, balance: "12.5x" } } },
    { rateLimits: { ...fixture.rateLimits, limitName: "/home/private/token" } },
    { rateLimits: null },
  ])("rejects malformed or unsafe provider data", (raw) => {
    expect(() => normalizeCodexRateLimits({
      ...fixture,
      ...raw,
    }, observedAt)).toThrow();
  });

  it("uses the verified app-server JSON-RPC flow and sends initialized", async () => {
    const testRuntime = await createFixtureExecutable();
    const probe = createCodexUsageProbe({
      command: testRuntime.command,
      cwd: testRuntime.directory,
      env: { MATRIX_TEST_RECORD: testRuntime.recordPath },
    });

    const [source] = await probe({
      signal: AbortSignal.timeout(2_000),
      now: () => observedAt,
    });

    expect(source?.windows.map((window) => window.remainingPercent)).toEqual([72, 41]);
    expect(await readFile(testRuntime.recordPath, "utf8")).toContain("initialized");
  });

  it("kills the app-server child when the caller aborts", async () => {
    const testRuntime = await createFixtureExecutable();
    const controller = new AbortController();
    const probe = createCodexUsageProbe({
      command: testRuntime.command,
      cwd: testRuntime.directory,
      env: {
        MATRIX_TEST_RECORD: testRuntime.recordPath,
        MATRIX_TEST_HANG: "1",
      },
    });
    const pending = probe({ signal: controller.signal, now: () => observedAt });
    await waitForFileText(testRuntime.recordPath, "initialized");

    controller.abort();

    await expect(pending).rejects.toThrow("Codex usage is unavailable");
    await expect(waitForFileText(testRuntime.recordPath, "killed")).resolves.toContain("killed");
  });

  it("caps provider output and never includes stderr details in errors", async () => {
    const testRuntime = await createFixtureExecutable();
    const probe = createCodexUsageProbe({
      command: testRuntime.command,
      cwd: testRuntime.directory,
      env: {
        MATRIX_TEST_RECORD: testRuntime.recordPath,
        MATRIX_TEST_OVERSIZED: "1",
      },
    });

    const pending = probe({ signal: AbortSignal.timeout(2_000), now: () => observedAt });

    await expect(pending).rejects.toThrow("Codex usage is unavailable");
    await expect(pending).rejects.not.toThrow(/secret-stderr|\/home\/private/);
  });
});

async function createFixtureExecutable(): Promise<{
  command: string;
  directory: string;
  recordPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "matrix-codex-usage-"));
  temporaryDirectories.push(directory);
  const command = join(directory, "codex-fixture.mjs");
  const recordPath = join(directory, "record.txt");
  const script = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.146.0\\n");
  process.exit(0);
}

const recordPath = process.env.MATRIX_TEST_RECORD;
const fixture = ${JSON.stringify(fixture)};
let buffer = "";

function record(value) {
  if (recordPath) appendFileSync(recordPath, value + "\\n");
}

function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

process.on("SIGTERM", () => {
  record("killed");
  process.exit(0);
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ id: message.id, result: { serverInfo: { name: "fixture" } } });
    } else if (message.method === "initialized") {
      record("initialized");
    } else if (message.method === "account/rateLimits/read") {
      if (process.env.MATRIX_TEST_HANG === "1") continue;
      if (process.env.MATRIX_TEST_OVERSIZED === "1") {
        process.stderr.write("secret-stderr /home/private/token\\n");
        process.stdout.write(JSON.stringify({ oversized: "x".repeat(70_000) }) + "\\n");
        continue;
      }
      send({ id: message.id, result: fixture });
    }
  }
});
`;
  await writeFile(command, script);
  await chmod(command, 0o700);
  return { command, directory, recordPath };
}

async function waitForFileText(path: string, expected: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, "utf8");
      if (text.includes(expected)) return text;
    } catch {
      // The fixture creates the record after the app-server handshake.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}
