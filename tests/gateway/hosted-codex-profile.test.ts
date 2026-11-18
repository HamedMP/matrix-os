import { describe, expect, it, vi } from "vitest";
import { runHostedCodexTextTurn } from "../../packages/gateway/src/app-ai/codex-profile-wire.js";
import { hostedCodexSandboxLaunch } from "../../packages/gateway/src/app-ai/codex-profile-completion.js";

function fakeServer(behavior = "normal") {
  return `
const readline = require("node:readline");
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
const cwd = "/work", threadId = "thread-hosted", turnId = "turn-hosted";
const behavior = ${JSON.stringify(behavior)};
let verified = 0;
let checkedMcp = false;
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
    case "thread/start":
      if (verified !== 0 || call.params.cwd !== cwd || !call.params.ephemeral
        || call.params.model !== "gpt-5.4" || call.params.approvalPolicy !== "never"
        || call.params.modelProvider !== "openai" || call.params.allowProviderModelFallback !== false
        || call.params.environments?.length !== 0 || call.params.runtimeWorkspaceRoots?.length !== 0
        || call.params.dynamicTools?.length !== 0) process.exit(6);
      reply({ thread: { id: threadId, ephemeral: true }, cwd, modelProvider: "openai",
        model: behavior === "wrong-model" ? "gpt-5.3-codex" : "gpt-5.4",
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
});
