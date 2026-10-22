import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openHermesSharedBrowserRun } from "../../packages/gateway/src/chat/hermes-shared-browser.js";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "matrix-hermes-browser-bootstrap-"));
  mkdirSync(join(root, "hermes_cli")); mkdirSync(join(root, "tui_gateway"));
  writeFileSync(join(root, "hermes_cli", "__init__.py"), ""); writeFileSync(join(root, "tui_gateway", "__init__.py"), "");
  writeFileSync(join(root, "hermes_cli", "config.py"), "value={'agent': {'disabled_toolsets':['cron']}, 'mcp_servers':{'owner_existing':{'command':'existing'}},'model':{'default':'owner-model'}}\ndef load_config(): return value\ndef load_config_readonly(): return value\n");
  writeFileSync(join(root, "tui_gateway", "entry.py"), "import json\nfrom hermes_cli.config import load_config,load_config_readonly,value\ncfg=load_config()\nprint(json.dumps({'config':cfg,'readonly':load_config_readonly(),'original':value}))\n");
  writeFileSync(join(root, "model_tools.py"), "def get_tool_definitions(**kwargs): return []\n");
  return root;
}
it("uses per-run native configuration overlay and actual Python bootstrap without writing owner settings", async () => {
  const root = fixture(); const browser = { openRun: vi.fn(() => ({ token: "a".repeat(43), expiresAt: Date.now()+60000 })), closeRun: vi.fn(async () => undefined) };
  try { const run = openHermesSharedBrowserRun({ broker: browser as never, root, gatewayPort: 4000,
    owner: { type: "personal", ownerId: "owner_qa" }, chatId: "chat_qa", runId: "run_qa", signal: new AbortController().signal });
    const result = spawnSync("python3", run.args, { env: { PATH: process.env.PATH, ...run.env }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.config.mcp_servers.matrix_shared_browser).toMatchObject({ command: "/opt/matrix/runtime/node/bin/node", args: ["/opt/matrix/app/packages/integrations-mcp/dist/shared-browser-cli.js"], timeout: 390, tools: { resources: false, prompts: false } });
    expect(value.config.mcp_servers.matrix_shared_browser.env).toEqual({ MATRIX_SHARED_BROWSER_TOKEN: "a".repeat(43), MATRIX_SHARED_BROWSER_GATEWAY_PORT: "4000" });
    expect(value.config.agent.disabled_toolsets).toEqual(["cron", "browser"]);
    expect(value.config.model.default).toBe("owner-model"); expect(value.readonly).toEqual(value.config);
    expect(value.original).not.toHaveProperty("mcp_servers.matrix_shared_browser");
    expect(value.original.agent.disabled_toolsets).toEqual(["cron"]);
    await run.close(); await run.close(); expect(browser.closeRun).toHaveBeenCalledOnce();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("requires exact native session tool catalog proof before prompt submission and rejects browser bypass", async () => {
  const browser = { openRun: vi.fn(() => ({ token: "a".repeat(43), expiresAt: Date.now()+60000 })), closeRun: vi.fn(async () => undefined) };
  const run = openHermesSharedBrowserRun({ broker: browser as never, root: "/fixed/native/hermes", gatewayPort: 4000,
    owner: { type: "personal", ownerId: "owner_qa" }, chatId: "chat_qa", runId: "run_qa", signal: new AbortController().signal });
  run.observe({ type: "session.info", session_id: "native_1", payload: { lazy: true } } as never);
  run.setSession("native_1");
  run.observe({ type: "session.info", session_id: "native_other", payload: { tools: { mcp: ["mcp__matrix_shared_browser__shared_browser"] } } } as never);
  const ready = run.ready(new AbortController().signal);
  run.observe({ type: "session.info", session_id: "native_1", payload: { tools: { mcp: ["mcp__matrix_shared_browser__shared_browser"], files: ["read_file"] } } } as never);
  await ready; await run.close();
  const blocked = openHermesSharedBrowserRun({ broker: browser as never, root: "/fixed/native/hermes", gatewayPort: 4000,
    owner: { type: "personal", ownerId: "owner_qa" }, chatId: "chat_qa", runId: "run_qa", signal: new AbortController().signal });
  blocked.setSession("native_2");
  blocked.observe({ type: "session.info", session_id: "native_2", payload: { tools: { mcp: ["mcp__matrix_shared_browser__shared_browser"], browser: ["browser_cdp"] } } } as never);
  await expect(blocked.ready(new AbortController().signal)).rejects.toThrow(); await blocked.close();
});
it("refuses non-personal owners before registering a browser run", () => {
  const browser = { openRun: vi.fn() };
  expect(() => openHermesSharedBrowserRun({ broker: browser as never, root: "/fixed/native/hermes", gatewayPort: 4000,
    owner: { type: "org", ownerId: "org_qa" } as never, chatId: "chat_qa", runId: "run_qa", signal: new AbortController().signal })).toThrow();
  expect(browser.openRun).not.toHaveBeenCalled();
});
