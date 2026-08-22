import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = join(process.cwd(), "scripts/configure-hermes-matrix-defaults.mjs");

async function runDefaults(hermesHome: string): Promise<void> {
  await execFileAsync(process.execPath, [scriptPath], {
    env: { PATH: process.env.PATH, HERMES_HOME: hermesHome },
  });
}

async function readConfig(hermesHome: string): Promise<Record<string, unknown>> {
  return parse(await readFile(join(hermesHome, "config.yaml"), "utf8")) as Record<string, unknown>;
}

describe("Matrix-managed Hermes defaults", () => {
  it("disables conflicting email skills while preserving existing configuration", async () => {
    const hermesHome = await mkdtemp(join(tmpdir(), "matrix-hermes-defaults-"));
    try {
      await writeFile(join(hermesHome, "config.yaml"), stringify({
        model: "test/model",
        skills: {
          disabled: ["user-disabled-skill"],
          config: { custom: { enabled: true } },
        },
      }), { mode: 0o600 });

      await runDefaults(hermesHome);

      expect(await readConfig(hermesHome)).toEqual({
        model: "test/model",
        mcp_servers: {
          "matrix-integrations": {
            command: "/opt/matrix/bin/matrix-integrations-mcp",
          },
        },
        skills: {
          disabled: ["google-workspace", "himalaya", "user-disabled-skill"],
          config: {
            custom: { enabled: true },
            matrix: { defaults_version: 1 },
          },
        },
      });
    } finally {
      await rm(hermesHome, { recursive: true, force: true });
    }
  });

  it("does not re-disable skills after the user changes a versioned default", async () => {
    const hermesHome = await mkdtemp(join(tmpdir(), "matrix-hermes-defaults-"));
    try {
      await runDefaults(hermesHome);
      const configured = await readConfig(hermesHome) as {
        skills: { disabled: string[]; config: { matrix: { defaults_version: number } } };
        mcp_servers?: Record<string, unknown>;
      };
      configured.skills.disabled = configured.skills.disabled.filter((name) => name !== "himalaya");
      delete configured.mcp_servers;
      await writeFile(join(hermesHome, "config.yaml"), stringify(configured), { mode: 0o600 });

      await runDefaults(hermesHome);

      const afterRestart = await readConfig(hermesHome) as {
        skills: { disabled: string[] };
      };
      expect(afterRestart.skills.disabled).toEqual(["google-workspace"]);
      expect((await readConfig(hermesHome)).mcp_servers).toEqual({
        "matrix-integrations": {
          command: "/opt/matrix/bin/matrix-integrations-mcp",
        },
      });
    } finally {
      await rm(hermesHome, { recursive: true, force: true });
    }
  });
});
