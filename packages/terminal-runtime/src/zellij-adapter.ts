import { execFile as nodeExecFile, spawn as spawnProcess } from "node:child_process";
import { chmod, mkdir, open, realpath as nodeRealpath, rename } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { spawn as spawnNodePty } from "node-pty";
import { z } from "zod/v4";
import { TerminalPaneActionSchema, type TerminalPaneAction } from "@matrix-os/contracts";
import type {
  ZellijAttachment,
  ZellijObserver,
  ZellijObserverEvent,
  ZellijRuntimeAdapter,
} from "./runtime.js";
import { createTerminalRuntimeEnvironment } from "./runtime-environment.js";

const MAX_COMMAND_OUTPUT_BYTES = 5 * 1024 * 1024;
const MAX_SUBSCRIPTION_LINE_BYTES = 1024 * 1024;
const STRUCTURED_READINESS_ATTEMPTS = 20;
const SESSION_NAME = /^matrix-w-[0-9a-f]{32}$/;
const TAB_NAME = /^matrix-tab-[0-9a-f]{32}$/;
const PANE_ID = /^terminal_[0-9]+$/;
const LEGACY_SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PaneSchema = z.object({
  id: z.number().int().min(0),
  is_plugin: z.boolean(),
  tab_id: z.number().int().min(0),
  pane_title: z.string().max(128).optional(),
}).passthrough();
const PaneGeometrySchema = PaneSchema.extend({
  pane_x: z.number().int().min(0),
  pane_y: z.number().int().min(0),
  pane_rows: z.number().int().min(1),
  pane_columns: z.number().int().min(1),
  is_floating: z.boolean().optional(),
  is_selectable: z.boolean().optional(),
});
type PaneGeometry = z.infer<typeof PaneGeometrySchema>;
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

export interface WorkspaceZellijTarget {
  sessionName: string;
  binaryPath: string;
}

export interface WorkspaceZellijLifecycle {
  resolveWorkspaceTarget(logicalSessionName: string): Promise<WorkspaceZellijTarget>;
  ensureWorkspaceSession(
    logicalSessionName: string,
    size: { cols: number; rows: number },
  ): Promise<WorkspaceZellijTarget>;
  deleteWorkspaceSession(logicalSessionName: string): Promise<void>;
}

export interface ZellijCliRuntimeAdapterOptions {
  homePath: string;
  env?: Record<string, string>;
  binaryPath?: string;
  timeoutMs?: number;
  run?: (args: string[], binaryPath?: string) => Promise<string>;
  resolveRealpath?: (path: string) => Promise<string>;
  spawnPty?: (args: string[], options: {
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    binaryPath?: string;
  }) => RuntimePty;
  spawnSubscription?: (
    args: string[],
    onLine: (line: string) => void,
    onExit: (exitCode: number | null) => void,
    binaryPath?: string,
  ) => RuntimeSubscriptionProcess;
  workspaceLifecycle?: WorkspaceZellijLifecycle;
}

export class ZellijCliRuntimeAdapter implements ZellijRuntimeAdapter {
  private readonly homePath: string;
  private readonly binaryPath: string;
  private readonly runCommand: NonNullable<ZellijCliRuntimeAdapterOptions["run"]>;
  private readonly resolveRealpath: (path: string) => Promise<string>;
  private readonly spawnPtyProcess: NonNullable<ZellijCliRuntimeAdapterOptions["spawnPty"]>;
  private readonly spawnSubscriptionProcess: NonNullable<ZellijCliRuntimeAdapterOptions["spawnSubscription"]>;
  private readonly workspaceLayoutPath: string;
  private readonly workspaceLifecycle?: WorkspaceZellijLifecycle;
  private readonly runtimeEnvironment: Record<string, string>;

  constructor(options: ZellijCliRuntimeAdapterOptions) {
    this.homePath = options.homePath;
    this.binaryPath = options.binaryPath ?? "/opt/matrix/bin/zellij";
    this.workspaceLayoutPath = join(options.homePath, "system", "zellij", "runtime-workspace.kdl");
    this.workspaceLifecycle = options.workspaceLifecycle;
    this.runtimeEnvironment = options.env ?? createTerminalRuntimeEnvironment({
      homePath: options.homePath,
      uid: process.getuid?.() ?? 0,
    });
    const currentGenerationRunner = createCommandRunner({
      binaryPath: this.binaryPath,
      cwd: this.homePath,
      env: this.runtimeEnvironment,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    this.runCommand = options.run ?? ((args, binaryPath) => {
      if (!binaryPath || binaryPath === this.binaryPath) return currentGenerationRunner(args);
      return createCommandRunner({
        binaryPath,
        cwd: this.homePath,
        env: this.runtimeEnvironment,
        timeoutMs: options.timeoutMs ?? 10_000,
      })(args);
    });
    this.resolveRealpath = options.resolveRealpath ?? nodeRealpath;
    this.spawnPtyProcess = options.spawnPty ?? ((args, spawnOptions) => {
      return spawnNodePty(spawnOptions.binaryPath ?? this.binaryPath, args, {
        name: "xterm-256color",
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        cols: spawnOptions.cols,
        rows: spawnOptions.rows,
      });
    });
    this.spawnSubscriptionProcess = options.spawnSubscription ?? ((args, onLine, onExit, binaryPath) => {
      return spawnLineProcess(binaryPath ?? this.binaryPath, args, this.homePath, this.runtimeEnvironment, onLine, onExit);
    });
  }

  async ensureSession(sessionNameInput: string, size = { cols: 120, rows: 36 }): Promise<void> {
    const logicalSessionName = z.string().regex(SESSION_NAME).parse(sessionNameInput);
    if (this.workspaceLifecycle) {
      const target = await this.workspaceLifecycle.ensureWorkspaceSession(logicalSessionName, size);
      await this.waitForSession(target.sessionName, target.binaryPath);
      return;
    }
    const sessionName = logicalSessionName;
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
      catch (error) {
        if (!isMissingZellijSessionFailure(error)) throw error;
        console.warn(
          "[terminal-runtime] legacy session already stopped",
          name,
          error instanceof Error ? error.name : "unknown_error",
        );
      }
    }
  }

  async stopWorkspaceSessions(names: string[]): Promise<void> {
    const requested = z.array(z.string().regex(SESSION_NAME)).max(10_000).parse(names);
    if (this.workspaceLifecycle) {
      for (const name of requested) await this.workspaceLifecycle.deleteWorkspaceSession(name);
      return;
    }
    const running = new Set(await this.listSessions());
    for (const name of requested) {
      if (!running.has(name)) continue;
      try { await this.deleteSession(name); } catch (error) { if (!isMissingZellijSessionFailure(error)) throw error; console.warn("[terminal-runtime] workspace session already stopped", error instanceof Error ? error.name : "unknown_error"); }
    }
  }

  async createTab(sessionNameInput: string, input: {
    internalName: string;
    cwd: string;
    command?: string[];
  }): Promise<{ tabId: number; paneId: string }> {
    const { sessionName, binaryPath } = await this.resolveWorkspaceTarget(sessionNameInput);
    const internalName = z.string().regex(TAB_NAME).parse(input.internalName);
    const cwd = await this.resolveCwd(input.cwd);
    const tabs = await this.readStructuredJson(
      ["--session", sessionName, "action", "list-tabs", "--json"],
      z.array(TabSchema).max(10_000),
      binaryPath,
    );
    const bootstrap = tabs.find((tab) => tab.name === "matrix-bootstrap");
    const output = await this.run([
      "--session", sessionName, "action", "new-tab",
      "--name", internalName,
      "--cwd", cwd,
      ...(input.command ? ["--", ...input.command] : []),
    ], binaryPath);
    const outputTabId = output.trim();
    const tabId = /^\d+$/.test(outputTabId)
      ? z.coerce.number().int().min(0).parse(outputTabId)
      : await this.waitForTabId(sessionName, internalName, binaryPath);
    if (bootstrap) {
      await this.run(["--session", sessionName, "action", "close-tab", "--tab-id", String(bootstrap.tab_id)], binaryPath);
    }
    const paneId = await this.waitForManagedPane(sessionName, tabId, binaryPath);
    await this.run(["--session", sessionName, "action", "rename-pane", "--pane-id", paneId, internalName], binaryPath);
    return { tabId, paneId };
  }

  async openAttachment(sessionNameInput: string, input: {
    paneId: string;
    size: { cols: number; rows: number };
    onData: (data: Uint8Array) => void;
    onExit: (exitCode: number | null) => void;
  }): Promise<ZellijAttachment> {
    const { sessionName, binaryPath } = await this.resolveWorkspaceTarget(sessionNameInput);
    const paneId = z.string().regex(PANE_ID).parse(input.paneId);
    const pty = this.spawnPtyProcess(["attach", sessionName], {
      cwd: this.homePath,
      env: this.runtimeEnvironment,
      cols: input.size.cols,
      rows: input.size.rows,
      binaryPath,
    });
    const dataDisposable = pty.onData((data) => input.onData(new TextEncoder().encode(data)));
    const exitDisposable = pty.onExit((event) => input.onExit(event.exitCode));
    await this.run(["--session", sessionName, "action", "focus-pane-id", paneId], binaryPath);
    let closed = false;
    return {
      write: async (data) => {
        if (closed) throw new Error("Terminal attachment closed");
        await this.run([
          "--session", sessionName, "action", "write-chars", "--pane-id", paneId, "--",
          new TextDecoder().decode(data),
        ], binaryPath);
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
    const { sessionName, binaryPath } = await this.resolveWorkspaceTarget(sessionNameInput);
    const paneId = z.string().regex(PANE_ID).parse(paneIdInput);
    await this.run([
      "--session", sessionName, "action", "write-chars", "--pane-id", paneId, "--",
      new TextDecoder().decode(data),
    ], binaryPath);
  }

  async paneAction(
    sessionNameInput: string,
    tabIdInput: number,
    paneIdInput: string,
    actionInput: TerminalPaneAction,
  ): Promise<void> {
    const { sessionName, binaryPath } = await this.resolveWorkspaceTarget(sessionNameInput);
    const tabId = z.number().int().min(0).parse(tabIdInput);
    const paneId = z.string().regex(PANE_ID).parse(paneIdInput);
    const action = TerminalPaneActionSchema.parse(actionInput);
    if (action.type === "split") {
      const createdPaneId = (await this.run([
        "--session", sessionName, "action", "new-pane",
        "--direction", action.direction,
        "--tab-id", String(tabId),
      ], binaryPath)).trim();
      z.string().regex(PANE_ID).parse(createdPaneId);
      return;
    }
    if (action.type === "focus") {
      const panes = await this.readStructuredJson(
        ["--session", sessionName, "action", "list-panes", "--all", "--json"],
        z.array(PaneGeometrySchema).max(10_000),
        binaryPath,
      );
      const targetPaneId = directionalPaneId(panes, tabId, paneId, action.direction);
      if (targetPaneId === paneId) return;
      await this.run(
        ["--session", sessionName, "action", "focus-pane-id", targetPaneId],
        binaryPath,
      );
      return;
    }
    await this.run(terminalPaneActionArgs(sessionName, paneId, action), binaryPath);
  }

  async findTabByInternalName(
    sessionNameInput: string,
    internalNameInput: string,
  ): Promise<{ tabId: number; paneId: string } | undefined> {
    const { sessionName, binaryPath } = await this.resolveWorkspaceTarget(sessionNameInput);
    const internalName = z.string().regex(TAB_NAME).parse(internalNameInput);
    const tabs = await this.readStructuredJson(
      ["--session", sessionName, "action", "list-tabs", "--json"],
      z.array(TabSchema).max(10_000),
      binaryPath,
    );
    const tab = tabs.find((candidate) => candidate.name === internalName);
    if (!tab) return undefined;
    const panes = await this.readStructuredJson(
      ["--session", sessionName, "action", "list-panes", "--all", "--json"],
      z.array(PaneSchema).max(10_000),
      binaryPath,
    );
    const managedPanes = panes.filter((pane) => pane.tab_id === tab.tab_id && !pane.is_plugin);
    const primaryPane = managedPanes.find((pane) => pane.pane_title === internalName)
      ?? managedPanes.toSorted((left, right) => left.id - right.id)[0];
    if (!primaryPane) throw new Error("Managed terminal tab primary pane is unavailable");
    const paneId = `terminal_${primaryPane.id}`;
    if (primaryPane.pane_title !== internalName) {
      await this.run(
        ["--session", sessionName, "action", "rename-pane", "--pane-id", paneId, internalName],
        binaryPath,
      );
    }
    return { tabId: tab.tab_id, paneId };
  }

  async subscribeWorkspace(sessionNameInput: string, input: {
    paneIds: string[];
    onEvent: (event: ZellijObserverEvent) => void;
  }): Promise<ZellijObserver> {
    const { sessionName, binaryPath } = await this.resolveWorkspaceTarget(sessionNameInput);
    const paneIds = z.array(z.string().regex(PANE_ID)).min(1).max(10_000).parse(input.paneIds);
    let eventChain = Promise.resolve();
    const args = ["--session", sessionName, "subscribe", "--pane-id", ...paneIds];
    // `--scrollback` accepts an optional variadic value, so keep it last. If it
    // precedes pane selectors clap can consume those selectors as values.
    args.push("--format", "json", "--ansi", "--scrollback");
    const onLine = (line: string) => {
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
        ], binaryPath);
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
    };
    const onExit = (exitCode: number | null) => {
      if (exitCode !== 0 && exitCode !== null) {
        console.error("[terminal-runtime] Zellij observer exited unexpectedly", exitCode);
      }
    };
    const process = binaryPath === this.binaryPath
      ? this.spawnSubscriptionProcess(args, onLine, onExit)
      : this.spawnSubscriptionProcess(args, onLine, onExit, binaryPath);
    return {
      close: async () => {
        await process.close();
        await eventChain;
      },
    };
  }

  async renameTab(sessionNameInput: string, tabId: number, nameInput: string): Promise<void> {
    const { sessionName, binaryPath } = await this.resolveWorkspaceTarget(sessionNameInput);
    const name = z.string().min(1).max(120).parse(nameInput);
    await this.run(["--session", sessionName, "action", "rename-tab", "--tab-id", String(tabId), name], binaryPath);
  }

  async closeTab(sessionNameInput: string, tabId: number): Promise<void> {
    const { sessionName, binaryPath } = await this.resolveWorkspaceTarget(sessionNameInput);
    await this.run(["--session", sessionName, "action", "close-tab", "--tab-id", String(tabId)], binaryPath);
  }

  async deleteSession(sessionNameInput: string): Promise<void> {
    const logicalSessionName = z.string().regex(SESSION_NAME).parse(sessionNameInput);
    if (this.workspaceLifecycle) {
      await this.workspaceLifecycle.deleteWorkspaceSession(logicalSessionName);
      return;
    }
    await this.run(["delete-session", logicalSessionName, "--force"]);
  }

  async resizeSession(sessionNameInput: string, size: { cols: number; rows: number }): Promise<void> {
    z.string().regex(SESSION_NAME).parse(sessionNameInput);
    const parsed = z.object({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).parse(size);
    // Detached workspaces acquire their effective grid from hard-size
    // attachments. The canonical size remains persisted by the runtime.
    void parsed;
  }

  private async listSessions(): Promise<string[]> {
    try {
      return (await this.run(["list-sessions", "--no-formatting"]))
        .split(/\r?\n/)
        .filter((line) => !/\bEXITED\b/i.test(line))
        .map((line) => line.trim().split(/\s+/)[0] ?? "")
        .filter((name) => SESSION_NAME.test(name));
    } catch (error) {
      if (isMissingZellijSessionFailure(error)) return [];
      console.warn(
        "[terminal-runtime] failed to list Zellij sessions",
        error instanceof Error ? error.name : "unknown_error",
      );
      throw error;
    }
  }

  private async resolveWorkspaceTarget(sessionNameInput: string): Promise<WorkspaceZellijTarget> {
    const logicalSessionName = z.string().regex(SESSION_NAME).parse(sessionNameInput);
    return this.workspaceLifecycle?.resolveWorkspaceTarget(logicalSessionName) ?? {
      sessionName: logicalSessionName,
      binaryPath: this.binaryPath,
    };
  }

  private async waitForSession(sessionName: string, binaryPath = this.binaryPath): Promise<void> {
    const deadline = Date.now() + 10_000;
    let loggedFailure = false;
    while (Date.now() < deadline) {
      try {
        await this.run(["--session", sessionName, "action", "list-panes", "--json"], binaryPath);
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

  private async resolveCwd(cwd: string): Promise<string> {
    if (cwd === "") return this.resolveRealpath(this.homePath);
    const parsed = z.string().max(4096)
      .refine((value) => !value.startsWith("/") && value.split("/").every((part) => part && part !== "." && part !== ".."))
      .parse(cwd);
    const [canonicalHome, canonicalCwd] = await Promise.all([
      this.resolveRealpath(this.homePath),
      this.resolveRealpath(join(this.homePath, parsed)),
    ]);
    const fromHome = relative(canonicalHome, canonicalCwd);
    if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
      throw new Error("Terminal cwd must stay within Matrix home");
    }
    return canonicalCwd;
  }

  private run(args: string[], binaryPath = this.binaryPath): Promise<string> {
    return binaryPath === this.binaryPath
      ? this.runCommand(args)
      : this.runCommand(args, binaryPath);
  }

  private async readStructuredJson<T>(
    args: string[],
    schema: z.ZodType<T>,
    binaryPath = this.binaryPath,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const output = (await this.run(args, binaryPath)).trim();
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

  private async waitForManagedPane(
    sessionName: string,
    tabId: number,
    binaryPath = this.binaryPath,
  ): Promise<string> {
    for (let attempt = 0; attempt < STRUCTURED_READINESS_ATTEMPTS; attempt += 1) {
      const panes = await this.readStructuredJson(
        ["--session", sessionName, "action", "list-panes", "--all", "--json"],
        z.array(PaneSchema).max(10_000),
        binaryPath,
      );
      const tabPanes = panes.filter((pane) => pane.tab_id === tabId && !pane.is_plugin);
      if (tabPanes.length === 1) return `terminal_${tabPanes[0]!.id}`;
      await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
    throw new Error("Managed terminal tab must contain exactly one pane");
  }

  private async waitForTabId(
    sessionName: string,
    internalName: string,
    binaryPath = this.binaryPath,
  ): Promise<number> {
    for (let attempt = 0; attempt < STRUCTURED_READINESS_ATTEMPTS; attempt += 1) {
      const tabs = await this.readStructuredJson(
        ["--session", sessionName, "action", "list-tabs", "--json"],
        z.array(TabSchema).max(10_000),
        binaryPath,
      );
      const tab = tabs.find((candidate) => candidate.name === internalName);
      if (tab) return tab.tab_id;
      await new Promise<void>((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
    throw new Error("Managed terminal tab failed to report its identifier");
  }
}

function terminalPaneActionArgs(
  sessionName: string,
  paneId: string,
  action: Exclude<TerminalPaneAction, { type: "split" | "focus" }>,
): string[] {
  const prefix = ["--session", sessionName, "action"];
  switch (action.type) {
    case "resize": return [...prefix, "resize", "increase", action.direction, "--pane-id", paneId];
    case "fullscreen": return [...prefix, "toggle-fullscreen", "--pane-id", paneId];
    case "scroll": return [
      ...prefix,
      action.edge === "top" ? "scroll-to-top" : "scroll-to-bottom",
      "--pane-id",
      paneId,
    ];
    case "close": return [...prefix, "close-pane", "--pane-id", paneId];
  }
}

function directionalPaneId(
  panes: PaneGeometry[],
  tabId: number,
  paneId: string,
  direction: "left" | "right" | "up" | "down",
): string {
  const sourceId = Number(paneId.slice("terminal_".length));
  const source = panes.find((pane) => !pane.is_plugin && pane.tab_id === tabId && pane.id === sourceId);
  if (!source) throw new Error("Terminal pane unavailable");
  const horizontal = direction === "left" || direction === "right";
  const sourcePrimary = horizontal
    ? source.pane_x + source.pane_columns / 2
    : source.pane_y + source.pane_rows / 2;
  const sourceSecondary = horizontal
    ? source.pane_y + source.pane_rows / 2
    : source.pane_x + source.pane_columns / 2;
  const candidates = panes.filter((pane) => {
    if (
      pane.is_plugin
      || pane.tab_id !== tabId
      || pane.id === source.id
      || pane.is_floating === true
      || pane.is_selectable === false
    ) return false;
    const primary = horizontal
      ? pane.pane_x + pane.pane_columns / 2
      : pane.pane_y + pane.pane_rows / 2;
    return direction === "left" || direction === "up"
      ? primary < sourcePrimary
      : primary > sourcePrimary;
  });
  candidates.sort((left, right) => {
    const score = (pane: PaneGeometry): [number, number, number] => {
      const primary = horizontal
        ? pane.pane_x + pane.pane_columns / 2
        : pane.pane_y + pane.pane_rows / 2;
      const secondary = horizontal
        ? pane.pane_y + pane.pane_rows / 2
        : pane.pane_x + pane.pane_columns / 2;
      return [Math.abs(primary - sourcePrimary), Math.abs(secondary - sourceSecondary), pane.id];
    };
    const leftScore = score(left);
    const rightScore = score(right);
    return leftScore[0] - rightScore[0]
      || leftScore[1] - rightScore[1]
      || leftScore[2] - rightScore[2];
  });
  return candidates[0] ? `terminal_${candidates[0].id}` : paneId;
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
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error("Terminal runtime command failed") as Error & { stderr?: string };
        const diagnostic = String(stderr);
        if (diagnostic) failure.stderr = diagnostic;
        reject(failure);
      } else resolve(String(stdout));
    });
  });
}

function isMissingZellijSessionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const stderr = (error as Error & { stderr?: unknown }).stderr;
  return typeof stderr === "string" && /(?:no active zellij sessions found|\bsession\b.*\b(?:not found|does not exist)\b)/i.test(stderr);
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
