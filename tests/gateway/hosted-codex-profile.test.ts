import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runHostedCodexTextTurn } from "../../packages/gateway/src/app-ai/codex-profile-wire.js";
import { hostedCodexSandboxLaunch } from "../../packages/gateway/src/app-ai/codex-profile-completion.js";
import { readHostedCodexModelIntent } from "../../packages/gateway/src/app-ai/codex-model-intent.js";

function fakeServer(behavior = "normal") {
  return `
const readline = require("node:readline");
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
const cwd = "/work", threadId = "thread-hosted", turnId = "turn-hosted";
const behavior = ${JSON.stringify(behavior)};
let verified = 0;
let checkedMcp = false;
const item = (id, isDefault) => ({ id, model:id, displayName:id, hidden:false, isDefault,
  defaultReasoningEffort:"low", supportedReasoningEfforts:[], inputModalities:["text"] });
const selectedModel = behavior === "configured-choice" ? "gpt-5.3-codex" : "gpt-5.4";
readline.createInterface({input: process.stdin}).on("line", line => {
  const call = JSON.parse(line);
  const reply = result => emit({ id: call.id, result });
  const notify = (method, params) => emit({ method, params });
  switch (call.method) {
    case "initialize":
      if (call.params.capabilities.experimentalApi !== true) process.exit(5);
      reply({ userAgent: "matrix-os/0.162.1 (Ubuntu; x86_64)", platformOs: "linux",
        platformFamily: "unix", codexHome: "/home/matrix-codex/.codex" }); break;
    case "initialized": break;
    case "config/read":
      if (!checkedMcp) process.exit(9);
      verified++; reply({ config: {} }); break;
    case "model/list":
      if (call.params.includeHidden !== false || call.params.limit !== 64) process.exit(10);
      reply({ data: [
        item("gpt-5.3-codex", behavior === "two-defaults"), item("gpt-5.4", behavior !== "no-default"),
      ], nextCursor: behavior === "partial-catalog" ? "continued" : null });
      break;
    case "thread/start":
      if (verified !== 0 || call.params.cwd !== cwd || !call.params.ephemeral
        || call.params.model !== selectedModel || call.params.approvalPolicy !== "never"
        || call.params.modelProvider !== "openai" || call.params.allowProviderModelFallback !== false
        || call.params.environments?.length !== 0 || call.params.runtimeWorkspaceRoots?.length !== 0
        || call.params.dynamicTools?.length !== 0) process.exit(6);
      reply({ thread: { id: threadId, ephemeral: true }, cwd, modelProvider: "openai",
        model: behavior === "wrong-model" ? "gpt-5.3-codex" : selectedModel,
        approvalPolicy: "never", sandbox: { type: "readOnly", networkAccess: false },
        instructionSources: [] });
      break;
    case "mcpServerStatus/list":
      checkedMcp = true;
      reply({ data: behavior === "mcp" ? [{ name: "unexpected" }] : [], nextCursor: null }); break;
    case "turn/start":
      if (verified !== 1 || call.params.threadId !== threadId || call.params.environments?.length !== 0
        || call.params.input?.length !== 1 || call.params.input[0].type !== "text"
        || call.params.input[0].text !== "What is 10 plus 21?") process.exit(7);
      if (behavior === "hang") return;
      if (behavior === "request") {
        emit({ id: "forbidden", method: "item/commandExecution/requestApproval", params: {} });
        return;
      }
      notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
      if (behavior === "item") notify("item/started", { threadId, turnId, item: { type: "commandExecution", id: "unexpected" } });
      notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "answer", text: "31" } });
      notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", error: null } });
      reply({ turn: { id: behavior === "wrong-turn" ? "other" : turnId } });
      break;
    default: process.exit(8);
  }
});`;
}

function setup(behavior?: string) {
  const signal = new AbortController();
  const authorize = vi.fn(async (request) => { await request("config/read", { cwd: "/work" }); });
  return { signal, authorize, options: {
    command: process.execPath, args: ["-e", fakeServer(behavior)], env: {},
    model: "gpt-5.4", prompt: "What is 10 plus 21?", signal: signal.signal, authorize,
  } };
}

describe("Hosted Bots native Codex text protocol", () => {
  it("mounts only the native auth file and uses an empty private home and workspace", () => {
    const authFile = "/home/matrix/home/.codex/auth.json";
    const launch = hostedCodexSandboxLaunch(authFile);
    expect(launch.command).toBe("/usr/bin/bwrap");
    expect(launch.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(launch.env.HOME).toBe("/home/matrix-codex");
    expect(launch.args).toContain("--unshare-pid");
    expect(launch.args).toContain("--die-with-parent");
    const auth = launch.args.indexOf(authFile);
    expect(launch.args.slice(auth - 1, auth + 2)).toEqual(["--ro-bind", authFile, "/home/matrix-codex/.codex/auth.json"]);
    expect(launch.args.filter(arg => arg.startsWith("/home/matrix/home"))).toEqual([authFile]);
    expect(launch.args).not.toContain("/run");
    expect(launch.args).toContain("features.shell_tool=false");
    expect(launch.args).toContain("features.apps=false");
    expect(launch.args).toContain("features.hooks=false");
    expect(launch.args).toContain("features.remote_plugin=false");
    expect(launch.args).toContain("features.browser_use=false");
    expect(launch.args).toContain("features.computer_use=false");
  });

  it("checks admission after isolated thread and MCP setup, then rechecks before returning text", async () => {
    const { options, authorize } = setup();
    await expect(runHostedCodexTextTurn(options)).resolves.toEqual({ text: "31" });
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("uses the exact native catalog default for the Matrix provider-default alias", async () => {
    const { options } = setup();
    await expect(runHostedCodexTextTurn({ ...options, model: "provider-default" })).resolves.toEqual({ text: "31" });
  });

  it("uses the owner’s configured native model even when the catalog default is different", async () => {
    const { options } = setup("configured-choice");
    await expect(runHostedCodexTextTurn({ ...options, model: "provider-default", configuredModel: "gpt-5.3-codex" }))
      .resolves.toEqual({ text: "31" });
  });

  it.each(["no-default", "two-defaults", "partial-catalog"])("refuses a catalog with %s", async behavior => {
    const { options, authorize } = setup(behavior);
    await expect(runHostedCodexTextTurn({ ...options, model: "provider-default" })).rejects.toMatchObject({ stage: "model" });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("refuses an unavailable configured native model before spending", async () => {
    const { options, authorize } = setup();
    await expect(runHostedCodexTextTurn({ ...options, model: "provider-default", configuredModel: "missing" }))
      .rejects.toMatchObject({ stage: "model" });
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each(["wrong-model", "wrong-turn", "mcp", "request", "item"])("refuses %s without returning text", async behavior => {
    await expect(runHostedCodexTextTurn(setup(behavior).options)).rejects.toThrow("Native Codex text completion unavailable");
  });

  it("aborts a hanging turn", async () => {
    const { options, signal } = setup("hang");
    const stop = setTimeout(() => signal.abort(), 100);
    try {
      await expect(runHostedCodexTextTurn(options)).rejects.toThrow("Native Codex text completion unavailable");
    } finally {
      clearTimeout(stop);
    }
  });

  it("suppresses a completed answer if current owner admission has been revoked", async () => {
    const { options, authorize } = setup();
    authorize.mockImplementationOnce(async request => { await request("config/read", { cwd: "/work" }); });
    authorize.mockImplementationOnce(async () => { throw new Error("Revoked"); });
    await expect(runHostedCodexTextTurn(options)).rejects.toThrow("Native Codex text completion unavailable");
  });

  it("refuses a new turn when admission changes during thread setup", async () => {
    const { options, authorize } = setup();
    authorize.mockImplementationOnce(async () => { throw new Error("Revoked"); });
    await expect(runHostedCodexTextTurn(options)).rejects.toMatchObject({ stage: "proof" });
    expect(authorize).toHaveBeenCalledTimes(1);
  });
});

describe("Hosted Bots native Codex model intent", () => {
  it("reads just the owner model and treats an absent config as native default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hosted-codex-intent-"));
    try {
      await expect(readHostedCodexModelIntent(dir)).resolves.toBeUndefined();
      await writeFile(join(dir, "config.toml"), 'model = "gpt-5.3-codex"\n[mcp_servers.other]\ncommand = "/never-run"\n');
      await expect(readHostedCodexModelIntent(dir)).resolves.toBe("gpt-5.3-codex");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each([
    'model_provider = "custom"\nmodel = "gpt-5.3-codex"',
    'profile = "mutable"\nmodel = "gpt-5.3-codex"',
    'model = "provider-default"',
    'model = 5',
  ])("refuses an unsupported model intent (%s)", async configuration => {
    const dir = await mkdtemp(join(tmpdir(), "hosted-codex-intent-"));
    try {
      await writeFile(join(dir, "config.toml"), configuration);
      await expect(readHostedCodexModelIntent(dir)).rejects.toThrow("Native Codex model unavailable");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses a symlinked or oversized configuration instead of using a default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hosted-codex-intent-"));
    try {
      const other = join(dir, "other.toml");
      const config = join(dir, "config.toml");
      await writeFile(other, 'model = "gpt-5.4"');
      await symlink(other, config);
      await expect(readHostedCodexModelIntent(dir)).rejects.toThrow("Native Codex model unavailable");
      await rm(config);
      await writeFile(config, "#".repeat(64 * 1024 + 1));
      await expect(readHostedCodexModelIntent(dir)).rejects.toThrow("Native Codex model unavailable");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
