// Screenshots of a linked desktop (spec 2716): the computer asks over the link,
// the desktop answers in bounded pieces, and the owner (or an agent on the
// computer) gets a JPEG. No Screen Recording permission on the desktop is a clear
// answer, never an empty image.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_LINK_CLOSE } from "@matrix-os/contracts/desktop-link";
import { terminalAgentToolDefinitions, type TerminalAgentKernelTools } from "../../packages/kernel/src/tools/terminal-agents.js";
import { desktopKernelTools } from "../../packages/gateway/src/desktop-link/kernel-tools.js";
import { createDesktopLinkRegistry } from "../../packages/gateway/src/desktop-link/registry.js";
import { shellMachineCommand } from "../../packages/sync-client/src/cli/commands/shell-machine.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";
import { cleanup, dialMac, enrol, gateway, LOCAL_TOKEN, ownerHeaders, testMac } from "./fixtures/desktop-link-harness.js";

// Larger than one piece, so the image really travels in parts.
const IMAGE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(150 * 1024)]);

async function linkedMac(screenshot: Buffer | "permission" | "unavailable" = IMAGE) {
  const registry = createDesktopLinkRegistry();
  const computer = await gateway({ registry });
  const mac = testMac();
  await enrol(computer.http, mac);
  const link = dialMac(computer.base, mac, { revision: 1, core: createFakeHerdrCore(), screenshot });
  await link.ready();
  return { ...computer, registry, mac, link, path: `/api/desktop-link/machines/${mac.deviceId}/screenshot` };
}

const post = { method: "POST", body: "{}" };

describe("desktop screenshots", () => {
  it("returns the desktop's JPEG to the owner and to agents on the computer, never to others", async () => {
    const { http, path } = await linkedMac();
    const shot = await http(path, post);
    expect(shot.status).toBe(200);
    expect(shot.headers.get("content-type")).toBe("image/jpeg");
    expect(shot.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await shot.arrayBuffer()).equals(IMAGE)).toBe(true);
    expect((await http(path, post, { authorization: `Bearer ${LOCAL_TOKEN}` })).status).toBe(200);
    expect((await http(path, post, ownerHeaders("org_member"))).status).toBe(403);
  });

  it("says plainly when the desktop does not allow Screen Recording", async () => {
    const { http, path } = await linkedMac("permission");
    const refused = await http(path, post);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "screen_recording_not_allowed" });
  });

  it("says when the desktop cannot capture its screen at all (Linux Wayland)", async () => {
    const { http, path } = await linkedMac("unavailable");
    const refused = await http(path, post);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "screenshot_unavailable" });
  });

  it("takes at most six a minute per desktop", async () => {
    const { http, path } = await linkedMac(Buffer.from([0xff, 0xd8]));
    const statuses: number[] = [];
    for (let index = 0; index < 7; index += 1) statuses.push((await http(path, post)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });

  it("closes a link that sends an oversized frame", async () => {
    const { base, mac } = await linkedMac();
    // A second link replaces the first; then it sends far more than any screenshot piece.
    const replacement = dialMac(base, mac, { revision: 1 });
    await replacement.ready();
    replacement.socket.send(JSON.stringify({ t: "capture-part", id: "abcdefgh", index: 0, last: true, data: "A".repeat(80 * 1024) }));
    await replacement.closed();
    expect(replacement.closeCode()).toBe(DESKTOP_LINK_CLOSE.policy);
  });
});

describe("desktop screenshots for the kernel and the CLI", () => {
  it("gives the model the screenshot as an image", async () => {
    const { registry } = await linkedMac();
    const tools = { ...desktopKernelTools(registry, () => "owner_mac") } as unknown as TerminalAgentKernelTools;
    const definition = terminalAgentToolDefinitions(tools).find((tool) => tool.name === "desktop_screenshot")!;
    const result = await definition.handler({}) as { content: Array<{ type: string; data?: string; mimeType?: string }> };
    expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(Buffer.from(result.content[0]!.data!, "base64").equals(IMAGE)).toBe(true);
  });

  it("asks the user for the permission when the desktop refuses", async () => {
    const { registry } = await linkedMac("permission");
    await expect(desktopKernelTools(registry, () => "owner_mac").desktopScreenshot({})).rejects.toMatchObject({ code: "screen_recording_not_allowed" });
  });

  it("saves the screenshot to a new file and never overwrites one", async () => {
    const { base } = await linkedMac();
    const dir = mkdtempSync(join(tmpdir(), "desktop-shot-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const output: string[] = [];
    const errors: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => { output.push(String(line)); });
    const error = vi.spyOn(console, "error").mockImplementation((line: unknown) => { errors.push(String(line)); });
    cleanup.push(() => { log.mockRestore(); error.mockRestore(); process.exitCode = 0; });
    const out = join(dir, "shot.jpg");
    const flags = ["--gateway", `http://${base}`, "--token", LOCAL_TOKEN];
    await runCommand(shellMachineCommand, { rawArgs: ["screenshot", "Hamed's MacBook", "--out", out, ...flags] });
    expect(output.at(-1)).toBe(out);
    expect(readFileSync(out).equals(IMAGE)).toBe(true);
    await runCommand(shellMachineCommand, { rawArgs: ["screenshot", "Hamed's MacBook", "--out", out, ...flags] });
    expect(errors.length).toBe(1);
  });
});
