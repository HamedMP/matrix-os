import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { closeAppAiCapabilities } from "../../packages/gateway/src/server/app-capabilities.js";
import { createPiSdkAppCompletion } from "../../packages/gateway/src/app-ai/pi-sdk-completion.js";
import { createGenericNativeWriter } from "../../packages/gateway/src/ai-providers/generic-native-writer.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function shutdownFixture(appAiRuntime: { close(): Promise<void> }) {
  const calls: string[] = [];
  const service = (name: string) => Object.fromEntries(
    ["close", "stop", "shutdown", "dispose", "destroy", "release", "waitForIdle", "shutdownAll", "shutdownPostHog"].map(method => [method, vi.fn(async () => { calls.push(`${name}.${method}`); })]),
  );
  const logBestEffortFailure = vi.fn();
  const dependencies = {
    appAiRuntime, closeAppAiCapabilities, logBestEffortFailure,
    jevInboxRuntime: null, chatDriveContext: service("drive"), matrixMcpCapabilities: service("mcp"),
    workspaceStartupRecoveryController: service("recovery"), terminalPasteAssetCleanup: service("paste"),
    chatIdleReaper: null, chatAttachmentCleanup: service("attachments"),
    hookRunner: { fireVoidHook: vi.fn(async () => undefined) }, pluginRegistry: { getServices: () => [] },
    heartbeat: service("heartbeat"), watchdog: service("watchdog"), proactiveHeartbeat: service("proactive"), cronService: service("cron"),
    localChatImportLifecycle: service("imports"), matrixAnthropicRuntime: service("anthropic"), providerWorkflowLifecycle: service("provider workflows"),
    backgroundChatProjection: service("projection"), slackRuntime: service("Slack"), companyBotSetup: service("company bots"), canonicalChatOrchestrator: service("chats"), botServices: service("bots"),
    canonicalChatRuntime: { agents: service("agents") }, gatewayCollaboration: service("collaboration"), scopeRuntimeHost: service("scope"),
    backgroundAgentRuntime: service("background agents"), codingAgentWorkspaceRuntime: service("workspaces"),
    workspaceSessionRuntimeBridge: service("workspace bridge"), terminalLiveOwnership: service("terminal"),
    agentRuntimeServices: { controller: service("controller") }, aiProviderService: service("providers"),
    fundedAdmission: service("funded admission"), fundedCredentialProvider: service("funded credentials"), jevRuntime: null,
    codingAgentTurnLifecycle: service("turns"), codexEventBridge: null, codingAgentThreadStream: null,
    codingAgentAttentionNotifications: null, codingAgentSessionStopReconciler: service("reconciler"),
    drainReconnectableAbortEntries: vi.fn(), reconnectableAbortControllers: new Map(), canvasCleanupTimer: null, canvasSubscriptionHub: null,
    systemActivityCandidates: new Set(), channelManager: service("channels"), customMcp: service("custom MCP"),
    processManager: service("processes"), forwardTunnelHub: service("tunnels"), watcher: service("watcher"),
    homeMirrorLifecycle: { mirror: null, startup: null }, syncR2: null,
    canonicalChatEventStream: null, chatRepository: service("Chat database"), closeCanonicalChatEventLifecycle: vi.fn(),
    canvasRepository: service("canvas database"), socialRoutes: service("social"), appDb: service("app database"),
    platformDb: service("platform database"), posthogErrorTracker: service("telemetry"), server: service("HTTP"),
  };
  // Exercise the actual production teardown sequence without booting a gateway.
  const source = ts.createSourceFile("server.ts", await readFile("packages/gateway/src/server.ts", "utf8"), ts.ScriptTarget.Latest, true);
  let body = "";
  function visit(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === "close" && node.body?.getText(source).includes("appAiRuntime")) body = node.body.getText(source);
    node.forEachChild(visit);
  }
  visit(source);
  expect(body).not.toBe("");
  const script = ts.transpileModule(`const close = async () => ${body};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const close = new Function(...Object.keys(dependencies), `${script};return close;`)(...Object.values(dependencies)) as () => Promise<void>;
  return { close, calls, logBestEffortFailure };
}

it("continues the actual gateway shutdown after app AI cleanup rejects", async () => {
  const failure = new Error("uncertain provider drain");
  const appAiRuntime = { close: vi.fn(async () => { throw failure; }) };
  const shutdown = await shutdownFixture(appAiRuntime);
  await expect(shutdown.close()).resolves.toBeUndefined();
  expect(appAiRuntime.close).toHaveBeenCalledOnce();
  expect(shutdown.logBestEffortFailure).toHaveBeenCalledWith("App AI adapter shutdown failed", failure);
  expect(shutdown.calls).toEqual(expect.arrayContaining([
    "anthropic.close", "Slack.close", "chats.close", "bots.close", "company bots.close", "providers.close", "Chat database.release",
    "app database.destroy", "platform database.destroy", "telemetry.shutdown", "HTTP.close",
  ]));
  expect(shutdown.calls.at(-1)).toBe("HTTP.close");
});

it("continues shutdown while retaining the real Pi writer fence after forced worker termination", async () => {
  const home = await mkdtemp(join(tmpdir(), "app-ai-shutdown-"));
  const marker = join(home, "refresh-started.json");
  const entry = join(home, "sdk.mjs");
  let scratch: string | undefined;
  await mkdir(join(home, ".pi/agent"), { recursive: true });
  await writeFile(join(home, ".pi/agent/auth.json"), JSON.stringify({ openai: { type: "api_key", key: "synthetic" } }));
  await writeFile(entry, `
import {readFile,writeFile} from 'node:fs/promises';
export class FileAuthStorageBackend {
  constructor(path){this.path=path;}
  async withLockAsync(fn){const value=await fn(await readFile(this.path,'utf8'));if(value.next!==undefined)await writeFile(this.path,value.next);return value.result;}
}
export class ModelRuntime {
  static async create(options){const runtime=new ModelRuntime();runtime.options=options;return runtime;}
  getError(){return undefined;}
  getPhysicalModel(provider,id){return {provider,id,api:'openai-completions',baseUrl:'https://api.openai.com/v1',maxTokens:8192};}
  async getAuth(model){await this.options.credentials.modify(model.provider,async()=>{
    await writeFile(${JSON.stringify(marker)},JSON.stringify({scratch:process.cwd()}));await new Promise(()=>{});
  });}
}
`);
  const pi = createPiSdkAppCompletion({ homePath: home, discover: async () => ({ node: process.execPath, entry: pathToFileURL(entry).href, env: {}, cwd: home }) });
  const pending = pi.generate({ providerId: "openai", modelId: "fixture", prompt: "No inference", signal: new AbortController().signal, revalidate: async () => true }).catch(error => error);
  try {
    await vi.waitFor(async () => { scratch = JSON.parse(await readFile(marker, "utf8")).scratch; }, { timeout: 2000 });
    const shutdown = await shutdownFixture(pi);
    vi.useFakeTimers();
    const closing = shutdown.close().then(() => ({ ok: true }), error => ({ ok: false, error }));
    await vi.advanceTimersByTimeAsync(20_100);
    expect(await closing).toEqual({ ok: true });
    expect(await pending).toBeInstanceOf(Error);
    expect(shutdown.logBestEffortFailure).toHaveBeenCalledWith("App AI adapter shutdown failed", expect.any(Error));
    expect(shutdown.calls).toContain("Slack.close");
    expect(shutdown.calls).toContain("company bots.close");
    expect(shutdown.calls).toContain("platform database.destroy");
    expect(shutdown.calls.at(-1)).toBe("HTTP.close");
    const fence = join(dirname(home), ".matrix-private", basename(home), "native-writers/pi.json");
    expect(await readFile(fence, "utf8")).toBeTruthy();
    await expect(createGenericNativeWriter(home).acquire("pi")).rejects.toThrow();
  } finally {
    vi.useRealTimers();
    await pi.close().catch(error => console.warn("[test] uncertain worker remains fenced", error instanceof Error ? error.name : "UnknownError"));
    await pending;
    if (scratch) await rm(scratch, { recursive: true, force: true });
    await rm(join(dirname(home), ".matrix-private", basename(home)), { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
