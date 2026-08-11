import { execFile as nodeExecFile, spawn as spawnProcess } from "node:child_process";
import { chmod, mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { spawn as spawnNodePty } from "node-pty";
import { z } from "zod/v4";
import type {
  ZellijAttachment,
  ZellijObserver,
  ZellijObserverEvent,
  ZellijRuntimeAdapter,
} from "./runtime.js";

const MAX_COMMAND_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_SUBSCRIPTION_LINE_BYTES = 1024 * 1024;
const SESSION_NAME = /^matrix-w-[0-9a-f]{32}$/;
const TAB_NAME = /^matrix-tab-[0-9a-f]{32}$/;
const PANE_ID = /^terminal_[0-9]+$/;
const LEGACY_SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PaneSchema = z.object({
  id: z.number().int().min(0),
  is_plugin: z.boolean(),
  tab_id: z.number().int().min(0),
}).passthrough();
const TabSchema = z.object({
  tab_id: z.number().int().min(0),
  name: z.string().max(128),
}).passthrough();
const SubscribeEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("pane_update"),
    pane_id: z.string().regex(PANE_ID),
    viewport: z.array(z.string().max(16_384)).max(200),
    scrollback: z.array(z.string().max(16_384)).max(100_000).nullable().optional(),
    is_initial: z.boolean().optional(),
  }).strict(),
  z.object({ event: z.literal("pane_closed"), pane_id: z.string().regex(PANE_ID) }).strict(),
]);

export interface RuntimePty {
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

export interface RuntimeSubscriptionProcess {
  close(): Promise<void>;
}

export interface ZellijCliRuntimeAdapterOptions {
  homePath: string;
  binaryPath?: string;
  timeoutMs?: number;
  run?: (args: string[]) => Promise<string>;
  spawnPty?: (args: string[], options: { cwd: string; env: Record<string, string>; cols: number; rows: number }) => RuntimePty;
  spawnSubscription?: (
    args: string[],
    onLine: (line: string) => void,
    onExit: (exitCode: number | null) => void,
  ) => RuntimeSubscriptionProcess;
}

export class ZellijCliRuntimeAdapter implements ZellijRuntimeAdapter {
  private readonly homePath: string;
  private readonly binaryPath: string;
  private readonly runCommand: (args: string[]) => Promise<string>;
  private readonly spawnPtyProcess: NonNullable<ZellijCliRuntimeAdapterOptions["spawnPty"]>;
  private readonly spawnSubscriptionProcess: NonNullable<ZellijCliRuntimeAdapterOptions["spawnSubscription"]>;
  private readonly workspaceLayoutPath: string;

  constructor(options: ZellijCliRuntimeAdapterOptions) {
    this.homePath = options.homePath;
    this.binaryPath = options.binaryPath ?? "/opt/matrix/bin/zellij";
    this.workspaceLayoutPath = join(options.homePath, "system", "zellij", "runtime-workspace.kdl");
    this.runCommand = options.run ?? createCommandRunner({
      binaryPath: this.binaryPath,
      cwd: this.homePath,
      env: runtimeEnv(options.homePath),
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    this.spawnPtyProcess = options.spawnPty ?? ((args, spawnOptions) => {
      return spawnNodePty(this.binaryPath, args, {
        name: "xterm-256color",
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        cols: spawnOptions.cols,
        rows: spawnOptions.rows,
      });
    });
    this.spawnSubscriptionProcess = options.spawnSubscription ?? ((args, onLine, onExit) => {
      return spawnLineProcess(this.binaryPath, args, this.homePath, runtimeEnv(this.homePath), onLine, onExit);
    });
  }

  async ensureSession(sessionNameInput: string, size = { cols: 120, rows: 36 }): Promise<void> {
    const sessionName = z.string().regex(SESSION_NAME).parse(sessionNameInput);
    if ((await this.listSessions()).includes(sessionName)) return;
    await this.ensureLayout();
    z.object({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).parse(size);
    await this.run([
      "attach", "--create-background", sessionName,
      "options", "--default-layout", this.workspaceLayoutPath,
    ]);
    await this.waitForSession(sessionName);
  }

  ensureWorkspace(sessionName: string, size: { cols: number; rows: number }): Promise<void> {
    return this.ensureSession(sessionName, size);
  }

  createShellTab(sessionName: string, input: { internalName: string; cwd: string }): Promise<{ tabId: number; paneId: string }> {
    return this.createTab(sessionName, input);
  }

  async stopLegacySessions(namesInput: string[]): Promise<void> {
    const names = z.array(z.string().regex(LEGACY_SESSION_NAME)).max(10_000).parse(namesInput);
    for (const name of names) {
      try { await this.run(["delete-session", name, "--force"]); }
      catch (error) { console.warn("[terminal-runtime] legacy session already stopped", name, error); }
    }
  }

  async stopWorkspaceSessions(names: string[]): Promise<void> {
    for (const name of z.array(z.string().regex(SESSION_NAME)).max(10_000).parse(names)) {
      await this.deleteSession(name);
    }
  }

  async createTab(sessionNameInput: string, input: {
    internalName: string;
    cwd: string;
    command?: string[];
  }): Promise<{ tabId: number; paneId: string }> {
    const sessionName = z.string().regex(SESSION_NAME).parse(sessionNameInput);
    const internalName = z.string().regex(TAB_NAME).parse(input.internalName);
    const cwd = this.resolveCwd(input.cwd);
    const tabs = await this.readStructuredJson(
      ["--session", sessionName, "action", "list-tabs", "--json"],
      z.array(TabSchema).max(10_000),
    );
    const bootstrap = tabs.find((tab) => tab.name === "matrix-bootstrap");
    const output = await this.run([
      "--session", sessionName, "action", "new-tab",
      "--name", internalName,
      "--cwd", cwd,
      ...(input.command ? ["--", ...input.command] : []),
    ]);
    const tabId = z.coerce.number().int().min(0).parse(output.trim());
    if (bootstrap) {
      await this.run(["--session", sessionName, "action", "close-tab", "--tab-id", String(bootstrap.tab_id)]);
    }
    const panes = await this.readStructuredJson(
      ["--session", sessionName, "action", "list-panes", "--all", "--json"],
      z.array(PaneSchema).max(10_000),
    );
    const tabPanes = panes.filter((pane) => pane.tab_id === tabId && !pane.is_plugin);
    if (tabPanes.length !== 1) throw new Error("Managed terminal tab must contain exactly one pane");
    const paneId = `terminal_${tabPanes[0]!.id}`;
    await this.run(["--session", sessionName, "action", "rename-pane", "--pane-id", paneId, internalName]);
    return { tabId, paneId };
  }

  async openAttachment(sessionNameInput: string, input: {
    paneId: string;
    size: { cols: number; rows: number };
    onData: (data: Uint8Array) => void;
    onExit: (exitCode: number | null) => void;
  }): Promise<ZellijAttachment> {
    const sessionName = z.string().regex(SESSION_NAME).parse(sessionNameInput);
    const paneId = z.string().regex(PANE_ID).parse(input.paneId);
    const pty = this.spawnPtyProcess(["attach", sessionName], {
      cwd: this.homePath,
      env: runtimeEnv(this.homePath),
      cols: input.size.cols,
      rows: input.size.rows,
    });
    const dataDisposable = pty.onData((data) => input.onData(new TextEncoder().encode(data)));
    const exitDisposable = pty.onExit((event) => input.onExit(event.exitCode));
    await this.run(["--session", sessionName, "action", "focus-pane-id", paneId]);
    let closed = false;
    return {
      write: async (data) => {
        if (closed) throw new Error("Terminal attachment closed");
        await this.run([
          "--session", sessionName, "action", "write-chars", "--pane-id", paneId, "--",
          new TextDecoder().decode(data),
        ]);
      },
      resize: async (cols, rows) => { if (!closed) pty.resize(cols, rows); },
      close: async () => {
        if (closed) return;
        closed = true;
        dataDisposable.dispose();
        exitDisposable.dispose();
        pty.kill();
      },
    };
  }

  async writeToPane(sessionNameInput: string, paneIdInput: string, data: Uint8Array): Promise<void> {
    const sessionName = z.string().regex(SESSION_NAME).parse(sessionNameInput);
    const paneId = z.string().regex(PANE_ID).parse(paneIdInput);
    await this.run([
      "--session", sessionName, "action", "write-chars", "--pane-id", paneId, "--",
      new TextDecoder().decode(data),
    ]);
  }

  async findTabByInternalName(
    sessionNameInput: string,
    internalNameInput: string,
  ): Promise<{ tabId: number; paneId: string } | undefined> {
    const sessionName = z.string().regex(SESSION_NAME).parse(sessionNameInput);
    const internalName = z.string().regex(TAB_NAME).parse(internalNameInput);
    const tabs = await this.readStructuredJson(
      ["--session", sessionName, "action", "list-tabs", "--json"],
      z.array(TabSchema).max(10_000),
    );
    const tab = tabs.find((candidate) => candidate.name === internalName);
    if (!tab) return undefined;
    const panes = await this.readStructuredJson(
      ["--session", sessionName, "action", "list-panes", "--all", "--json"],
      z.array(PaneSchema).max(10_000),
    );
    const managedPanes = panes.filter((pane) => pane.tab_id === tab.tab_id && !pane.is_plugin);
    if (managedPanes.length !== 1) throw new Error("Managed terminal tab must contain exactly one pane");
    return { tabId: tab.tab_id, paneId: `terminal_${managedPanes[0]!.id}` };
  }

  async subscribeWorkspace(sessionNameInput: string, input: {
    paneIds: string[];
    onEvent: (event: ZellijObserverEvent) => void;
  }): Promise<ZellijObserver> {
    const sessionName = z.string().regex(SESSION_NAME).parse(sessionNameInput);
    const paneIds = z.array(z.string().regex(PANE_ID)).min(1).max(10_000).parse(input.paneIds);
    let eventChain = Promise.resolve();
    const args = ["--session", sessionName, "subscribe", "--pane-id", ...paneIds];
    // `--scrollback` accepts an optional variadic value, so keep it last. If it
    // precedes pane selectors clap can consume those selectors as values.
    args.push("--format", "json", "--ansi", "--scrollback");
    const process = this.spawnSubscriptionProcess(args, (line) => {
      if (Buffer.byteLength(line) > MAX_SUBSCRIPTION_LINE_BYTES) return;
      const parsed = SubscribeEventSchema.safeParse(safeJson(line));
      if (!parsed.success) {
        console.error("[terminal-runtime] rejected invalid Zellij observer event", parsed.error.issues.map((issue) => issue.path.join(".")));
        return;
      }
      eventChain = eventChain.then(async () => {
        if (parsed.data.event === "pane_closed") {
          input.onEvent({ type: "pane-closed", paneId: parsed.data.pane_id });
          return;
        }
        const ansi = await this.run([
          "--session", sessionName, "action", "dump-screen", "--pane-id", parsed.data.pane_id, "--full", "--ansi",
        ]);
        const fullLines = ansi.split(/\r?\n/);
        const scrollback = parsed.data.scrollback ?? fullLines.slice(0, Math.max(0, fullLines.length - parsed.data.viewport.length));
        input.onEvent({
          type: "pane-update",
          paneId: parsed.data.pane_id,
          ansi,
          viewport: parsed.data.viewport,
          scrollback,
        });
      }).catch((error: unknown) => {
        console.error("[terminal-runtime] Zellij observer update failed", error);
      });
    }, (exitCode) => {
      if (exitCode !== 0 && exitCode !== null) {
        console.error("[terminal-runtime] Zellij observer exited unexpectedly", exitCode);
      }
    });
    return {
      close: async () => {
        await process.close();
        await eventChain;
      },
    };
  }

  async renameTab(sessionNameInput: string, tabId: number, nameInput: string): Promise<void> {
    const sessionName = z.string().regex(SESSION_NAME).parse(sessionNameInput);
    const name = z.string().min(1).max(120).parse(nameInput);
    await this.run(["--session", sessionName, "action", "rename-tab", "--tab-id", String(tabId), name]);
  }

  async closeTab(sessionNameInput: string, tabId: number): Promise<void> {
    const sessionName = z.string().regex(SESSION_NAME).parse(sessionNameInput);
    await this.run(["--session", sessionName, "action", "close-tab", "--tab-id", String(tabId)]);
  }

  async deleteSession(sessionNameInput: string): Promise<void> {
    const sessionName = z.string().regex(SESSION_NAME).parse(sessionNameInput);
    await this.run(["delete-session", sessionName, "--force"]);
  }

  async resizeSession(sessionNameInput: string, size: { cols: number; rows: number }): Promise<void> {
    const sessionName = z.string().regex(SESSION_NAME).parse(sessionNameInput);
    const parsed = z.object({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).parse(size);
    // Detached workspaces acquire their effective grid from hard-size
    // attachments. The canonical size remains persisted by the runtime.
    void parsed;
  }

  private async listSessions(): Promise<string[]> {
    try {
      return (await this.run(["list-sessions", "--no-formatting"]))
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[0] ?? "")
        .filter((name) => SESSION_NAME.test(name));
    } catch (error) {
      console.warn(
        "[terminal-runtime] failed to list Zellij sessions",
        error instanceof Error ? error.name : "unknown_error",
      );
      return [];
    }
  }

  private async waitForSession(sessionName: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    let loggedFailure = false;
    while (Date.now() < deadline) {
      try {
        await this.run(["--session", sessionName, "action", "list-panes", "--json"]);
        return;
      } catch (error) {
        if (!loggedFailure) {
          console.warn(
            "[terminal-runtime] waiting for Zellij workspace",
            error instanceof Error ? error.name : "unknown_error",
          );
          loggedFailure = true;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error("Terminal workspace failed to start");
  }

  private async ensureLayout(): Promise<void> {
    const content = 'layout {\n  tab name="matrix-bootstrap" focus=true {\n    pane\n  }\n}\n';
    await mkdir(join(this.homePath, "system", "zellij"), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.workspaceLayoutPath}.${process.pid}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
    await rename(temporaryPath, this.workspaceLayoutPath);
    await chmod(this.workspaceLayoutPath, 0o600);
  }

  private resolveCwd(cwd: string): string {
    if (cwd === "") return this.homePath;
    const parsed = z.string().max(4096)
      .refine((value) => !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== ".."))
      .parse(cwd);
    return join(this.homePath, parsed);
  }

  private run(args: string[]): Promise<string> {
    return this.runCommand(args);
  }

  private async readStructuredJson<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const output = (await this.run(args)).trim();
        const arrayStart = output.indexOf("[");
        const objectStart = output.indexOf("{");
        const start = arrayStart < 0
          ? objectStart
          : objectStart < 0
            ? arrayStart
            : Math.min(arrayStart, objectStart);
        const end = Math.max(output.lastIndexOf("]"), output.lastIndexOf("}"));
        if (start < 0 || end < start) {
          throw new Error("Zellij structured command returned non-JSON output");
        }
        return schema.parse(JSON.parse(output.slice(start, end + 1)));
      } catch (error) {
        lastError = error;
        await new Promise<void>((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Zellij structured command failed");
  }
}

function createCommandRunner(options: {
  binaryPath: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}): (args: string[]) => Promise<string> {
  return (args) => new Promise((resolve, reject) => {
    nodeExecFile(options.binaryPath, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    }, (error, stdout) => {
      if (error) reject(new Error("Terminal runtime command failed"));
      else resolve(String(stdout));
    });
  });
}

function spawnLineProcess(
  binaryPath: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  onLine: (line: string) => void,
  onExit: (exitCode: number | null) => void,
): RuntimeSubscriptionProcess {
  const child = spawnProcess(binaryPath, args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_SUBSCRIPTION_LINE_BYTES * 2) {
      buffer = "";
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line) onLine(line);
  });
  child.once("exit", onExit);
  return {
    close: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
        timer.unref();
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

function runtimeEnv(homePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string" || key === "ZELLIJ" || key === "ZELLIJ_SESSION_NAME" || key === "ZELLIJ_PANE_ID") continue;
    env[key] = value;
  }
  env.HOME = homePath;
  env.MATRIX_HOME = homePath;
  env.ZELLIJ_CONFIG_DIR = join(homePath, "system", "zellij");
  return env;
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    console.warn(
      "[terminal-runtime] rejected malformed Zellij observer JSON",
      error instanceof Error ? error.name : "unknown_error",
    );
    return null;
  }
}
