import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profileCommand } from "../../packages/sync-client/src/cli/commands/profile.js";

const roots: string[] = [];
const originalHome = process.env.HOME;

async function tempHome() {
  const root = await mkdtemp(join(tmpdir(), "matrix-profile-cli-"));
  roots.push(root);
  process.env.HOME = root;
  return root;
}

function captureLogs() {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
    logs.push(String(line));
  });
  return logs;
}

beforeEach(async () => {
  process.exitCode = undefined;
  await tempHome();
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("profile CLI command", () => {
  it("registers ls, show, use, and set subcommands", () => {
    expect(Object.keys(profileCommand.subCommands ?? {}).sort()).toEqual([
      "ls",
      "set",
      "show",
      "use",
    ]);
  });

  it("lists default profiles with the active profile in JSON output", async () => {
    const logs = captureLogs();

    await profileCommand.subCommands!.ls.run!({ args: { json: true } } as never);

    expect(JSON.parse(logs[0])).toEqual({
      v: 1,
      ok: true,
      data: {
        active: "cloud",
        profiles: [
          {
            name: "cloud",
            active: true,
            platformUrl: "https://app.matrix-os.com",
            gatewayUrl: "https://app.matrix-os.com",
          },
          {
            name: "local",
            active: false,
            platformUrl: "http://localhost:9000",
            gatewayUrl: "http://localhost:4000",
          },
        ],
      },
    });
  });

  it("sets and shows a named profile", async () => {
    const logs = captureLogs();

    await profileCommand.subCommands!.set.run!({
      args: {
        name: "staging",
        platform: "https://platform.example",
        gateway: "https://gateway.example",
        json: true,
      },
    } as never);
    await profileCommand.subCommands!.show.run!({
      args: { name: "staging", json: true },
    } as never);

    expect(logs.map((line) => JSON.parse(line))).toEqual([
      {
        v: 1,
        ok: true,
        data: {
          name: "staging",
          active: false,
          platformUrl: "https://platform.example",
          gatewayUrl: "https://gateway.example",
        },
      },
      {
        v: 1,
        ok: true,
        data: {
          name: "staging",
          active: false,
          platformUrl: "https://platform.example",
          gatewayUrl: "https://gateway.example",
        },
      },
    ]);
  });

  it("switches the active profile without changing other profile data", async () => {
    const home = process.env.HOME!;
    const logs = captureLogs();

    await profileCommand.subCommands!.set.run!({
      args: {
        name: "staging",
        platform: "https://platform.example",
        gateway: "https://gateway.example",
      },
    } as never);
    await profileCommand.subCommands!.use.run!({
      args: { name: "staging", json: true },
    } as never);

    const stored = JSON.parse(await readFile(join(home, ".matrixos", "profiles.json"), "utf-8"));
    expect(stored.active).toBe("staging");
    expect(stored.profiles.cloud.gatewayUrl).toBe("https://app.matrix-os.com");
    expect(JSON.parse(logs.at(-1)!)).toEqual({
      v: 1,
      ok: true,
      data: { active: "staging" },
    });
  });
});
