import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLocalTerminalConnection } from "../../packages/sync-client/src/cli/local-terminal-connection.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const TOKEN = "a".repeat(64);
const PANE = { ZELLIJ_SESSION_NAME: `matrix-rt_${"b".repeat(32)}`, ZELLIJ_PANE_ID: "7" };

async function home(token: string | null = TOKEN) {
  const path = await mkdtemp(join(tmpdir(), "matrix-local-terminal-"));
  homes.push(path);
  if (token !== null) {
    await mkdir(join(path, ".cache", "matrix"), { recursive: true, mode: 0o700 });
    await writeFile(join(path, ".cache", "matrix", "terminal-agent.token"), `${token}\n`, { mode: 0o600 });
  }
  return path;
}

// Fault detected (live test on the #3300 preview): inside a Matrix terminal the CLI only
// knew cloud profiles, so an agent could not run, report to or wait on its helpers.
describe("calls from inside a Matrix terminal", () => {
  it("use the machine's own gateway with the local token", async () => {
    const path = await home();
    await expect(resolveLocalTerminalConnection({}, { ...PANE, HOME: path })).resolves.toEqual({
      gatewayUrl: "http://127.0.0.1:4000",
      token: TOKEN,
    });
    await expect(resolveLocalTerminalConnection({}, { ...PANE, MATRIX_HOME: path, PORT: "4100" })).resolves
      .toMatchObject({ gatewayUrl: "http://127.0.0.1:4100" });
  });

  it("leave explicit profiles and calls from outside a Matrix terminal to the profile", async () => {
    const path = await home();
    await expect(resolveLocalTerminalConnection({ profile: "cloud" }, { ...PANE, HOME: path })).resolves.toBeNull();
    await expect(resolveLocalTerminalConnection({ gateway: "https://x" }, { ...PANE, HOME: path })).resolves.toBeNull();
    await expect(resolveLocalTerminalConnection({}, { HOME: path, ZELLIJ_SESSION_NAME: "work", ZELLIJ_PANE_ID: "1" })).resolves.toBeNull();
  });

  it("refuse a missing, malformed or symlinked token instead of calling the cloud", async () => {
    await expect(resolveLocalTerminalConnection({}, { ...PANE, HOME: await home(null) }))
      .rejects.toMatchObject({ code: "local_gateway_unavailable" });
    await expect(resolveLocalTerminalConnection({}, { ...PANE, HOME: await home("not-a-token") }))
      .rejects.toMatchObject({ code: "local_gateway_unavailable" });
    const linked = await home(null);
    const real = await home();
    await mkdir(join(linked, ".cache", "matrix"), { recursive: true });
    await symlink(join(real, ".cache", "matrix", "terminal-agent.token"), join(linked, ".cache", "matrix", "terminal-agent.token"));
    await expect(resolveLocalTerminalConnection({}, { ...PANE, HOME: linked }))
      .rejects.toMatchObject({ code: "local_gateway_unavailable" });
    const open = await home();
    await chmod(join(open, ".cache", "matrix", "terminal-agent.token"), 0o644);
    await expect(resolveLocalTerminalConnection({}, { ...PANE, HOME: open }))
      .rejects.toMatchObject({ code: "local_gateway_unavailable" });
  });
});
