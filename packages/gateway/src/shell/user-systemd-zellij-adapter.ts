import { randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { MatrixZellijShellThemeId } from "./zellij-config.js";
import { matrixZellijConfigPaths } from "./zellij-config.js";
import { shellError } from "./errors.js";
import type { createUserSystemdTerminalRuntime, UserSystemdTerminalDescriptor } from "./user-systemd-terminal-runtime.js";
import { createZellijAdapter, type AttachOptions, type ZellijAdapter } from "./zellij.js";

type RuntimeController = Pick<
  ReturnType<typeof createUserSystemdTerminalRuntime>,
  "create" | "start" | "delete" | "get" | "list" | "findByDisplayName" | "renameDisplayName"
>;

const MAX_GENERATION_ADAPTERS = 8;

function runtimeId(): string {
  return `rt_${randomBytes(16).toString("hex")}`;
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaping = false;
  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
    } else if (char === "\\" && quote !== "'") {
      escaping = true;
    } else if ((char === "\"" || char === "'") && quote === null) {
      quote = char;
    } else if (char === quote) {
      quote = null;
    } else if (quote === null && /\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (escaping || quote !== null) throw shellError("invalid_command", "Invalid command", 400);
  if (current) parts.push(current);
  if (parts.length === 0) throw shellError("invalid_command", "Invalid command", 400);
  return parts;
}

function kdlString(value: string): string {
  return JSON.stringify(value);
}

function commandLayout(command: string, cwd?: string, shellFile?: string): string {
  const commandArgs = splitCommand(command);
  const [binary, ...args] = shellFile ? [shellFile, ...commandArgs] : commandArgs;
  const attributes = [cwd ? `cwd=${kdlString(cwd)}` : null, `command=${kdlString(binary)}`]
    .filter(Boolean)
    .join(" ");
  const argLine = args.length > 0 ? `      args ${args.map(kdlString).join(" ")}\n` : "";
  return `layout {\n  tab name="main" {\n    pane ${attributes} {\n${argLine}    }\n  }\n}\n`;
}

async function writeTextExclusive(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(tempPath, content, { flag: "wx", mode: 0o600 });
    try {
      await link(tempPath, path);
    } catch (err: unknown) {
      if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST")) throw err;
      if (await readFile(path, "utf8") !== content) throw shellError("session_exists", "Session already exists", 409);
    }
  } finally {
    try {
      await rm(tempPath, { force: true });
    } catch (err: unknown) {
      if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
        console.warn("[terminal-runtime] failed to remove temporary shell runtime file");
      }
    }
  }
}

export function createUserSystemdZellijAdapter(options: {
  homePath: string;
  generation: string;
  controller: RuntimeController;
  terminalRuntimeRoot?: string;
  baseAdapter?: ZellijAdapter;
  adapterFactory?: (binaryPath: string) => ZellijAdapter;
  runtimeIdGenerator?: () => string;
}): ZellijAdapter {
  const homePath = resolve(options.homePath);
  const terminalRuntimeRoot = resolve(options.terminalRuntimeRoot ?? "/opt/matrix/terminal-runtime");
  const uid = process.getuid?.();
  const terminalEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(uid == null ? {} : { XDG_RUNTIME_DIR: `/run/user/${uid}` }),
  };
  const configPaths = matrixZellijConfigPaths(homePath);
  const currentBinary = join(terminalRuntimeRoot, "generations", options.generation, "zellij");
  const baseAdapter = options.baseAdapter ?? createZellijAdapter({ homePath, binaryPath: currentBinary, env: terminalEnv });
  const adapterFactory = options.adapterFactory ?? ((binaryPath: string) => createZellijAdapter({
    homePath,
    binaryPath,
    env: terminalEnv,
    manageConfig: false,
  }));
  const generateRuntimeId = options.runtimeIdGenerator ?? runtimeId;
  let descriptorCache: UserSystemdTerminalDescriptor[] = [];
  const generationAdapters = new Map<string, ZellijAdapter>();

  function cacheDescriptor(descriptor: UserSystemdTerminalDescriptor): void {
    descriptorCache = [
      ...descriptorCache.filter((entry) => (
        entry.runtimeId !== descriptor.runtimeId && entry.displayName !== descriptor.displayName
      )),
      descriptor,
    ];
  }

  function adapterFor(descriptor: UserSystemdTerminalDescriptor): ZellijAdapter {
    const cached = generationAdapters.get(descriptor.generation);
    if (cached) {
      generationAdapters.delete(descriptor.generation);
      generationAdapters.set(descriptor.generation, cached);
      return cached;
    }
    if (generationAdapters.size >= MAX_GENERATION_ADAPTERS) {
      const oldest = generationAdapters.keys().next().value as string | undefined;
      if (oldest) generationAdapters.delete(oldest);
    }
    const adapter = adapterFactory(join(terminalRuntimeRoot, "generations", descriptor.generation, "zellij"));
    generationAdapters.set(descriptor.generation, adapter);
    return adapter;
  }

  async function descriptorFor(name: string): Promise<UserSystemdTerminalDescriptor> {
    const cached = descriptorCache.find((entry) => entry.displayName === name);
    if (cached) return cached;
    const descriptor = await options.controller.findByDisplayName("terminal", name);
    if (!descriptor) throw shellError("session_not_found", "Session not found", 404);
    cacheDescriptor(descriptor);
    return descriptor;
  }

  function cachedDescriptorForAttach(name: string): UserSystemdTerminalDescriptor {
    const descriptor = descriptorCache.find((entry) => entry.displayName === name);
    if (!descriptor) throw shellError("session_not_found", "Session not found", 404);
    return descriptor;
  }

  async function delegate<T>(name: string, operation: (adapter: ZellijAdapter, sessionName: string) => Promise<T>): Promise<T> {
    const descriptor = await descriptorFor(name);
    return operation(adapterFor(descriptor), descriptor.sessionName);
  }

  return {
    health: () => baseAdapter.health(),

    async listSessions() {
      const descriptors = await options.controller.list({ scope: "terminal", runningOnly: true });
      descriptorCache = descriptors;
      return descriptors.map((descriptor) => descriptor.displayName);
    },

    focusedPaneRuntime(name) {
      return delegate(name, (adapter, sessionName) => adapter.focusedPaneRuntime(sessionName));
    },

    async createSession(input) {
      const existing = await options.controller.findByDisplayName("terminal", input.name);
      if (existing) {
        throw shellError("session_interrupted", "Session requires explicit recovery", 409);
      }
      const health = await baseAdapter.health();
      if (!health.ok) throw shellError("zellij_failed", "Shell operation failed", 500);
      const nextRuntimeId = generateRuntimeId();
      const cwd = input.cwd ?? homePath;
      const layoutPath = join(homePath, "system", "zellij", "runtime-layouts", `${nextRuntimeId}.kdl`);
      let layoutContent: string;
      if (input.cmd) {
        layoutContent = commandLayout(input.cmd, input.cwd, configPaths.shellFile);
      } else if (input.layout) {
        layoutContent = await readFile(join(homePath, "system", "layouts", `${input.layout}.kdl`), "utf8");
      } else {
        layoutContent = await readFile(configPaths.layoutFile, "utf8");
      }
      if (Buffer.byteLength(layoutContent) > 100_000) throw shellError("invalid_layout", "Invalid layout", 400);
      await writeTextExclusive(layoutPath, layoutContent);
      let created;
      try {
        created = await options.controller.create({
          runtimeId: nextRuntimeId,
          scope: "terminal",
          kind: "shell",
          displayName: input.name,
          cwd,
          layoutPath,
        });
      } catch (err: unknown) {
        let persisted: UserSystemdTerminalDescriptor | null;
        try {
          persisted = await options.controller.get(nextRuntimeId);
        } catch (lookupErr: unknown) {
          if (!(lookupErr instanceof Error)) throw lookupErr;
          console.warn("[terminal-runtime] failed to reconcile shell runtime after create failure");
          throw err;
        }
        if (persisted?.layoutPath !== layoutPath) await rm(layoutPath, { force: true });
        throw err;
      }
      cacheDescriptor(created);
    },

    async deleteSession(name, deleteOptions = {}) {
      const descriptor = await options.controller.findByDisplayName("terminal", name);
      if (!descriptor) {
        if (deleteOptions.force) return;
        throw shellError("session_not_found", "Session not found", 404);
      }
      await options.controller.delete(descriptor.runtimeId);
      descriptorCache = descriptorCache.filter((entry) => entry.runtimeId !== descriptor.runtimeId);
      const generatedLayout = join(homePath, "system", "zellij", "runtime-layouts", `${descriptor.runtimeId}.kdl`);
      if (descriptor.layoutPath === generatedLayout) await rm(generatedLayout, { force: true });
    },

    async renameSession(name, nextName) {
      const descriptor = await descriptorFor(name);
      const next = await options.controller.renameDisplayName(descriptor.runtimeId, nextName);
      descriptorCache = descriptorCache.filter((entry) => entry.runtimeId !== descriptor.runtimeId);
      cacheDescriptor(next);
    },

    validateLayout: (path) => baseAdapter.validateLayout(path),

    attachSession(name, attachOptions: AttachOptions = {}) {
      const descriptor = cachedDescriptorForAttach(name);
      return adapterFor(descriptor).attachSession(descriptor.sessionName, attachOptions);
    },

    sendInput: (name, data) => delegate(name, (adapter, sessionName) => adapter.sendInput(sessionName, data)),
    listTabs: (name) => delegate(name, (adapter, sessionName) => adapter.listTabs(sessionName)),
    createTab: (name, input) => delegate(name, (adapter, sessionName) => adapter.createTab(sessionName, input)),
    switchTab: (name, tab) => delegate(name, (adapter, sessionName) => adapter.switchTab(sessionName, tab)),
    closeTab: (name, tab) => delegate(name, (adapter, sessionName) => adapter.closeTab(sessionName, tab)),
    splitPane: (name, input) => delegate(name, (adapter, sessionName) => adapter.splitPane(sessionName, input)),
    closePane: (name, pane) => delegate(name, (adapter, sessionName) => adapter.closePane(sessionName, pane)),
    applyLayout: (name, layout) => delegate(name, (adapter, sessionName) => adapter.applyLayout(sessionName, layout)),
    dumpLayout: (name) => delegate(name, (adapter, sessionName) => adapter.dumpLayout(sessionName)),
    setShellTheme: (themeId: MatrixZellijShellThemeId) => baseAdapter.setShellTheme(themeId),
  };
}
