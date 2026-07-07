import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defineCommand } from "citty";
import { resolveCliProfile } from "../profiles.js";
import { formatCliError, formatCliErrorMessage, formatCliSuccess } from "../output.js";
import { createShellClient } from "../shell-client.js";
import type { ShellAttachOptions } from "../shell-client.js";
import { requireCliAuthToken } from "../auth-state.js";
import { uploadLocalFile } from "../file-transfer-client.js";

const SHELL_USAGE = "Usage: mos shell list|new|attach|paste-file|paste-clipboard|paste-screenshot|rm|tab|pane|layout";
const BRACKETED_PASTE_OPEN = "\x1b[200~";
const BRACKETED_PASTE_CLOSE = "\x1b[201~";
const TERMINAL_PASTE_FILE_DIR = "data/terminal-paste";
const MATRIX_HOME_ABSOLUTE_PATH = "/home/matrix/home";
const MAX_PASTE_SOURCE_BYTES = 10 * 1024 * 1024;
const SHELL_SUBCOMMANDS = new Set([
  "ls", "list",
  "new",
  "attach", "connect",
  "paste-file",
  "paste-clipboard",
  "paste-screenshot",
  "rm",
  "tab", "pane", "layout",
]);
const SHELL_VALUE_OPTIONS = new Set(["--gateway", "--profile", "--token"]);

function hasShellSubCommand(rawArgs: string[] | undefined): boolean {
  if (!Array.isArray(rawArgs)) {
    return false;
  }
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--") {
      const next = rawArgs[i + 1];
      return typeof next === "string" && SHELL_SUBCOMMANDS.has(next);
    }
    if (arg.startsWith("--")) {
      const [option] = arg.split("=", 1);
      if (SHELL_VALUE_OPTIONS.has(option) && !arg.includes("=")) {
        i += 1;
      }
      continue;
    }
    return SHELL_SUBCOMMANDS.has(arg);
  }
  return false;
}

async function clientFromArgs(args: Record<string, unknown>) {
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);
  return createShellClient({ gatewayUrl: profile.gatewayUrl, token });
}

function invalidRequestError(): Error {
  return Object.assign(new Error("Request failed"), { code: "invalid_request" });
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function parseTabIndex(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw invalidRequestError();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidRequestError();
  }
  return parsed;
}

function parsePaneDirection(value: unknown): "right" | "down" {
  if (value === undefined) {
    return "right";
  }
  if (value !== "right" && value !== "down") {
    throw invalidRequestError();
  }
  return value;
}

function writeError(err: unknown, json: boolean): void {
  const code =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "request_failed";
  const canShowErrorMessage =
    code === "not_authenticated" ||
    (code === "auth_expired" && err instanceof Error && err.message !== "Request failed") ||
    code === "clipboard_unavailable" ||
    code === "screenshot_unavailable" ||
    code === "payload_too_large";
  const safeMessage =
    canShowErrorMessage && err instanceof Error
      ? err.message
      : undefined;
  const output = json
    ? formatCliError(code, safeMessage)
    : code === "auth_expired" || code === "gateway_unreachable" || code === "request_timeout" || code === "zellij_failed" || code === "attach_failed"
      ? formatCliErrorMessage(code, safeMessage)
      : safeMessage ?? formatCliErrorMessage(code);
  console.error(output);
}

const commonArgs = {
  profile: { type: "string", required: false },
  dev: { type: "boolean", required: false, default: false },
  gateway: { type: "string", required: false },
  token: { type: "string", required: false },
  json: { type: "boolean", required: false, default: false },
} as const;

async function runShellJsonCommand(
  args: Record<string, unknown>,
  run: () => Promise<Record<string, unknown>>,
  human: (data: Record<string, unknown>) => string,
): Promise<void> {
  const json = args.json === true;
  try {
    const data = await run();
    console.log(json ? formatCliSuccess(data) : human(data));
  } catch (err) {
    writeError(err, json);
    process.exitCode = 1;
  }
}

function parseFromSeq(value: unknown): number | undefined {
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
}

function attachOptionsFromArgs(args: Record<string, unknown>) {
  const options: ShellAttachOptions = {
    fromSeq: parseFromSeq(args.fromSeq),
  };
  if (args.json === true) {
    options.output = process.stderr;
  }
  if (args.noMouse === true) {
    options.mouse = false;
  }
  if (args.noRichPaste === true) {
    options.noRichPaste = true;
  }
  if (typeof args.cwd === "string") {
    options.cwd = args.cwd;
  }
  if (typeof args.WebSocketImpl === "function") {
    options.WebSocketImpl = args.WebSocketImpl as ShellAttachOptions["WebSocketImpl"];
  }
  return options;
}

function attachOptionsForOutput(args: Record<string, unknown>, json: boolean) {
  const options = attachOptionsFromArgs(args);
  if (json) {
    options.output = process.stderr;
    options.errorOutput = process.stderr;
  }
  return options;
}

function sessionCreateInput(args: Record<string, unknown>) {
  return {
    name: String(args.name),
    cwd: typeof args.cwd === "string" ? args.cwd : undefined,
    layout: typeof args.layout === "string" ? args.layout : undefined,
    cmd: typeof args.cmd === "string" ? args.cmd : undefined,
  };
}

function bracketTerminalPaste(text: string): string {
  const safe = text.replace(/\x1b\[20[01]~/g, "");
  const capped = safe.slice(0, 65_536 - BRACKETED_PASTE_OPEN.length - BRACKETED_PASTE_CLOSE.length);
  return `${BRACKETED_PASTE_OPEN}${capped}${BRACKETED_PASTE_CLOSE}`;
}

type PasteFormat = "path" | "prompt" | "markdown";

type ClipboardImage = {
  bytes: Buffer;
  extension: string;
  basename?: string;
};

type ScreenshotCapture = {
  path: string;
  cleanup?: () => Promise<void>;
};

function normalizeRemotePath(path: string): string {
  return path.replace(/^~\//, "").replace(/^\/home\/matrix\/home\//, "").replace(/^\/+/, "");
}

function absoluteMatrixPath(remotePath: string): string {
  return `${MATRIX_HOME_ABSOLUTE_PATH}/${normalizeRemotePath(remotePath)}`;
}

function parsePasteFormat(value: unknown): PasteFormat {
  if (value === undefined) return "prompt";
  if (value === "path" || value === "prompt" || value === "markdown") return value;
  throw invalidRequestError();
}

function isImageRemotePath(remotePath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/i.test(remotePath);
}

function formatPasteText(input: {
  remotePath: string;
  format: PasteFormat;
  message?: unknown;
}): string {
  const remotePath = normalizeRemotePath(input.remotePath);
  const absolutePath = absoluteMatrixPath(remotePath);
  const homePath = `~/${remotePath}`;
  const message = typeof input.message === "string" && input.message.trim().length > 0
    ? input.message.trim()
    : "";
  const label = isImageRemotePath(remotePath) ? "Screenshot" : "File";

  if (input.format === "path") {
    return absolutePath;
  }
  if (input.format === "markdown") {
    return `${message ? `${message}\n\n` : ""}[${label}](${absolutePath})`;
  }
  return `${message ? `${message}\n\n` : ""}${label} attached at ${absolutePath} (also ${homePath}). Please inspect it.`;
}

function safeRemotePasteBasename(localPath: string): string {
  const clean = basename(localPath).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean.length > 0 ? clean.slice(0, 96) : "pasted-file";
}

function defaultRemotePastePath(localPath: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${TERMINAL_PASTE_FILE_DIR}/${stamp}-${randomUUID().slice(0, 8)}-${safeRemotePasteBasename(localPath)}`;
}

function defaultClipboardRemotePath(extension: string, name = "clipboard"): string {
  const cleanExtension = extension.replace(/^\.+/, "") || "png";
  const cleanName = name.toLowerCase().endsWith(`.${cleanExtension.toLowerCase()}`)
    ? name
    : `${name}.${cleanExtension}`;
  return defaultRemotePastePath(cleanName);
}

function execFileBuffer(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: "buffer",
      maxBuffer: MAX_PASTE_SOURCE_BYTES,
      timeout: 10_000,
    }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

function execFileQuiet(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function defaultReadClipboardImage(): Promise<ClipboardImage> {
  const os = platform();
  let lastError: unknown;

  if (os === "darwin") {
    const dir = await mkdtemp(join(tmpdir(), "matrix-clipboard-"));
    const path = join(dir, "clipboard.png");
    try {
      await execFileQuiet("pngpaste", [path]);
      const bytes = await readFile(path);
      return { bytes, extension: "png", basename: "clipboard.png" };
    } catch (err: unknown) {
      lastError = err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  if (os === "linux") {
    const candidates: Array<{ command: string; args: string[]; extension: string }> = [
      { command: "wl-paste", args: ["--type", "image/png", "--no-newline"], extension: "png" },
      { command: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"], extension: "png" },
    ];
    for (const candidate of candidates) {
      try {
        const bytes = await execFileBuffer(candidate.command, candidate.args);
        return { bytes, extension: candidate.extension, basename: `clipboard.${candidate.extension}` };
      } catch (err: unknown) {
        lastError = err;
      }
    }
  }

  throw codedError(
    lastError instanceof Error
      ? "Clipboard image paste is not available. Install pngpaste on macOS, or wl-paste/xclip on Linux."
      : "Clipboard image paste is not supported on this platform yet.",
    "clipboard_unavailable",
  );
}

async function writeTempClipboardImage(image: ClipboardImage): Promise<ScreenshotCapture> {
  if (image.bytes.byteLength > MAX_PASTE_SOURCE_BYTES) {
    throw codedError("Clipboard image is too large for upload.", "payload_too_large");
  }
  const extension = image.extension.replace(/[^A-Za-z0-9]+/g, "").slice(0, 12) || "png";
  const dir = await mkdtemp(join(tmpdir(), "matrix-clipboard-"));
  const path = join(dir, safeRemotePasteBasename(image.basename ?? `clipboard.${extension}`));
  try {
    await writeFile(path, image.bytes, { flag: "wx", mode: 0o600 });
  } catch (err: unknown) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function defaultCaptureScreenshot(area: boolean): Promise<ScreenshotCapture> {
  const dir = await mkdtemp(join(tmpdir(), "matrix-screenshot-"));
  const path = join(dir, "screenshot.png");
  try {
    if (platform() === "darwin") {
      await execFileQuiet("screencapture", [area ? "-i" : "-x", "-t", "png", path]);
    } else if (platform() === "linux") {
      await execFileQuiet("gnome-screenshot", [...(area ? ["-a"] : []), "-f", path]);
    } else {
      throw codedError("Screenshot capture is not supported on this platform yet.", "screenshot_unavailable");
    }
  } catch (err: unknown) {
    await rm(dir, { recursive: true, force: true });
    if (err instanceof Error && "code" in err && (err as { code?: unknown }).code === "screenshot_unavailable") {
      throw err;
    }
    throw codedError(
      platform() === "darwin"
        ? "Screenshot capture failed. Check macOS screen recording permissions."
        : "Screenshot capture failed. Install gnome-screenshot or save a file and use `mos shell paste-file`.",
      "screenshot_unavailable",
    );
  }
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function pasteLocalFileIntoShell(args: Record<string, unknown>, input: {
  localPath: string;
  remotePath: string;
}): Promise<{ path: string; size: number; session: string }> {
  const profile = await resolveCliProfile(args);
  const token = await requireCliAuthToken(profile);
  const result = await uploadLocalFile(
    { gatewayUrl: profile.gatewayUrl, token },
    input.localPath,
    input.remotePath,
    { force: args.force === true },
  );
  const client = createShellClient({ gatewayUrl: profile.gatewayUrl, token });
  const text = formatPasteText({
    remotePath: result.path,
    format: parsePasteFormat(args.format),
    message: args.message,
  });
  await client.sendInput(
    String(args.session),
    `${bracketTerminalPaste(text)}${args.enter === true ? "\r" : ""}`,
  );
  return { path: result.path, size: result.size, session: String(args.session) };
}

function listCommand(name: string, description: string) {
  return defineCommand({
    meta: { name, description },
    args: commonArgs,
    run: async ({ args }) => {
      const json = args.json === true;
      try {
        const sessions = await (await clientFromArgs(args)).listSessions();
        if (json) {
          console.log(formatCliSuccess({ sessions }));
        } else if (sessions.length === 0) {
          console.log("No shell sessions.");
        } else {
          for (const session of sessions) {
            const sessionName =
              typeof session === "object" && session !== null && "name" in session
                ? String((session as { name: unknown }).name)
                : String(session);
            console.log(sessionName);
          }
        }
      } catch (err) {
        writeError(err, json);
        process.exitCode = 1;
      }
    },
  });
}

function attachCommand(name: string, description: string) {
  return defineCommand({
    meta: { name, description },
    args: {
      name: { type: "positional", required: true },
      create: {
        type: "boolean",
        alias: "c",
        required: false,
        default: false,
        description: "Create the session if it does not exist before connecting",
      },
      cwd: { type: "string", required: false },
      layout: { type: "string", required: false },
      cmd: { type: "string", required: false },
      noMouse: { type: "boolean", required: false, default: false },
      noRichPaste: { type: "boolean", required: false, default: false },
      fromSeq: { type: "string", required: false },
      ...commonArgs,
    },
    run: async ({ args }) => {
      const json = args.json === true;
      try {
        const client = await clientFromArgs(args);
        let result: { detached: boolean };
        try {
          result = await client.attachSession(String(args.name), attachOptionsForOutput(args, json));
        } catch (err) {
          const code = err instanceof Error && "code" in err
            ? (err as { code?: unknown }).code
            : undefined;
          if (args.create !== true || code !== "session_not_found") {
            throw err;
          }
          const data = await client.createSession(sessionCreateInput(args));
          if (json) {
            result = await client.attachSession(String(args.name), attachOptionsForOutput(args, json));
            console.log(formatCliSuccess({ created: data, detached: result.detached }));
            return;
          }
          console.log(`Created shell session ${args.name}. Connecting...`);
          result = await client.attachSession(String(args.name), attachOptionsForOutput(args, json));
        }
        console.log(
          json
            ? formatCliSuccess({ detached: result.detached })
            : result.detached
              ? `Detached. Reattach: mos shell attach ${args.name}`
              : `Shell attach ended. Reattach: mos shell attach ${args.name}`,
        );
      } catch (err) {
        writeError(err, json);
        process.exitCode = 1;
      }
    },
  });
}

export const shellCommand = defineCommand({
  meta: {
    name: "shell",
    description: "Manage Matrix OS terminal sessions",
  },
  args: {
    profile: { type: "string", required: false },
    dev: { type: "boolean", required: false, default: false },
    gateway: { type: "string", required: false },
    token: { type: "string", required: false },
    json: { type: "boolean", required: false, default: false },
  },
  subCommands: {
    ls: listCommand("ls", "List shell sessions"),
    list: listCommand("list", "List shell sessions"),
    new: defineCommand({
      meta: { name: "new", description: "Create a shell session" },
      args: {
        name: { type: "positional", required: true },
        cwd: { type: "string", required: false },
        layout: { type: "string", required: false },
        cmd: { type: "string", required: false },
        attach: { type: "boolean", required: false, default: false },
        noMouse: { type: "boolean", required: false, default: false },
        noRichPaste: { type: "boolean", required: false, default: false },
        ...commonArgs,
      },
      run: async ({ args }) => {
        const json = args.json === true;
        try {
          const client = await clientFromArgs(args);
          const data = await client.createSession(sessionCreateInput(args));
          if (args.attach !== true) {
            console.log(json ? formatCliSuccess(data) : `Created shell session ${args.name}`);
            return;
          }
          if (!json) {
            console.log(`Created shell session ${args.name}. Attaching...`);
          }
          const result = await client.attachSession(String(args.name), attachOptionsForOutput(args, json));
          console.log(
            json
              ? formatCliSuccess({ created: data, detached: result.detached })
              : result.detached
                ? `Detached. Reattach: mos shell attach ${args.name}`
                : `Shell attach ended. Reattach: mos shell attach ${args.name}`,
          );
        } catch (err) {
          writeError(err, json);
          process.exitCode = 1;
        }
      },
    }),
    attach: attachCommand("attach", "Attach to a shell session"),
    connect: attachCommand("connect", "Connect to a shell session"),
    "paste-file": defineCommand({
      meta: { name: "paste-file", description: "Upload a local file and paste an agent-readable prompt into a shell session" },
      args: {
        session: { type: "positional", required: true },
        local: { type: "positional", required: true },
        remote: { type: "string", required: false },
        format: { type: "string", required: false },
        message: { type: "string", required: false },
        enter: { type: "boolean", required: false, default: false },
        force: { type: "boolean", required: false, default: false },
        ...commonArgs,
      },
      run: async ({ args }) => {
        const json = args.json === true;
        try {
          const remotePath = typeof args.remote === "string" && args.remote.trim().length > 0
            ? args.remote.trim()
            : defaultRemotePastePath(String(args.local));
          const result = await pasteLocalFileIntoShell(args, {
            localPath: String(args.local),
            remotePath,
          });
          console.log(
            json
              ? formatCliSuccess({ path: result.path, size: result.size, session: String(args.session) })
              : `Pasted ${absoluteMatrixPath(result.path)} into shell session ${args.session}`,
          );
        } catch (err) {
          writeError(err, json);
          process.exitCode = 1;
        }
      },
    }),
    "paste-clipboard": defineCommand({
      meta: { name: "paste-clipboard", description: "Upload the current clipboard image and paste an agent-readable prompt into a shell session" },
      args: {
        session: { type: "positional", required: true },
        remote: { type: "string", required: false },
        format: { type: "string", required: false },
        message: { type: "string", required: false },
        enter: { type: "boolean", required: false, default: false },
        force: { type: "boolean", required: false, default: false },
        ...commonArgs,
      },
      run: async ({ args }) => {
        const json = args.json === true;
        let temp: ScreenshotCapture | null = null;
        try {
          const readClipboardImage = typeof args.readClipboardImage === "function"
            ? args.readClipboardImage as () => Promise<ClipboardImage>
            : defaultReadClipboardImage;
          const image = await readClipboardImage();
          temp = await writeTempClipboardImage(image);
          const remotePath = typeof args.remote === "string" && args.remote.trim().length > 0
            ? args.remote.trim()
            : defaultClipboardRemotePath(image.extension, image.basename ?? "clipboard");
          const result = await pasteLocalFileIntoShell(args, {
            localPath: temp.path,
            remotePath,
          });
          console.log(
            json
              ? formatCliSuccess({ path: result.path, size: result.size, session: String(args.session) })
              : `Pasted ${absoluteMatrixPath(result.path)} into shell session ${args.session}`,
          );
        } catch (err) {
          writeError(err, json);
          process.exitCode = 1;
        } finally {
          if (temp?.cleanup) {
            await temp.cleanup().catch((err: unknown) => {
              console.warn("Failed to clean up clipboard paste temp file:", err instanceof Error ? err.message : err);
            });
          }
        }
      },
    }),
    "paste-screenshot": defineCommand({
      meta: { name: "paste-screenshot", description: "Capture a screenshot and paste an agent-readable prompt into a shell session" },
      args: {
        session: { type: "positional", required: true },
        remote: { type: "string", required: false },
        format: { type: "string", required: false },
        message: { type: "string", required: false },
        area: { type: "boolean", required: false, default: false },
        enter: { type: "boolean", required: false, default: false },
        force: { type: "boolean", required: false, default: false },
        ...commonArgs,
      },
      run: async ({ args }) => {
        const json = args.json === true;
        let capture: ScreenshotCapture | null = null;
        try {
          const captureScreenshot = typeof args.captureScreenshot === "function"
            ? args.captureScreenshot as (area: boolean) => Promise<ScreenshotCapture>
            : defaultCaptureScreenshot;
          capture = await captureScreenshot(args.area === true);
          const remotePath = typeof args.remote === "string" && args.remote.trim().length > 0
            ? args.remote.trim()
            : defaultRemotePastePath(capture.path);
          const result = await pasteLocalFileIntoShell(args, {
            localPath: capture.path,
            remotePath,
          });
          console.log(
            json
              ? formatCliSuccess({ path: result.path, size: result.size, session: String(args.session) })
              : `Pasted ${absoluteMatrixPath(result.path)} into shell session ${args.session}`,
          );
        } catch (err) {
          writeError(err, json);
          process.exitCode = 1;
        } finally {
          if (capture?.cleanup) {
            await capture.cleanup().catch((err: unknown) => {
              console.warn("Failed to clean up screenshot paste temp file:", err instanceof Error ? err.message : err);
            });
          }
        }
      },
    }),
    rm: defineCommand({
      meta: { name: "rm", description: "Remove a shell session" },
      args: {
        name: { type: "positional", required: true },
        force: { type: "boolean", required: false, default: false },
        profile: { type: "string", required: false },
        dev: { type: "boolean", required: false, default: false },
        gateway: { type: "string", required: false },
        token: { type: "string", required: false },
        json: { type: "boolean", required: false, default: false },
      },
      run: async ({ args }) => {
        const json = args.json === true;
        try {
          await (await clientFromArgs(args)).deleteSession(String(args.name), {
            force: args.force === true,
          });
          console.log(json ? formatCliSuccess({ ok: true }) : `Removed shell session ${args.name}`);
        } catch (err) {
          writeError(err, json);
          process.exitCode = 1;
        }
      },
    }),
    tab: defineCommand({
      meta: { name: "tab", description: "Manage shell tabs" },
      subCommands: {
        new: defineCommand({
          meta: { name: "new", description: "Create a tab" },
          args: {
            session: { type: "string", required: true },
            name: { type: "string", required: false },
            cwd: { type: "string", required: false },
            cmd: { type: "string", required: false },
            ...commonArgs,
          },
          run: async ({ args }) => runShellJsonCommand(args, async () => (
            await (await clientFromArgs(args)).createTab(String(args.session), {
              name: typeof args.name === "string" ? args.name : undefined,
              cwd: typeof args.cwd === "string" ? args.cwd : undefined,
              cmd: typeof args.cmd === "string" ? args.cmd : undefined,
            })
          ), () => "Created tab"),
        }),
        ls: defineCommand({
          meta: { name: "ls", description: "List tabs" },
          args: { session: { type: "string", required: true }, ...commonArgs },
          run: async ({ args }) => runShellJsonCommand(args, async () => ({
            tabs: await (await clientFromArgs(args)).listTabs(String(args.session)),
          }), () => "Listed tabs"),
        }),
        go: defineCommand({
          meta: { name: "go", description: "Switch tab" },
          args: { session: { type: "string", required: true }, tab: { type: "string", required: true }, ...commonArgs },
          run: async ({ args }) => runShellJsonCommand(args, async () => (
            await (await clientFromArgs(args)).switchTab(String(args.session), parseTabIndex(args.tab))
          ), () => "Switched tab"),
        }),
        close: defineCommand({
          meta: { name: "close", description: "Close tab" },
          args: { session: { type: "string", required: true }, tab: { type: "string", required: true }, ...commonArgs },
          run: async ({ args }) => runShellJsonCommand(args, async () => (
            await (await clientFromArgs(args)).closeTab(String(args.session), parseTabIndex(args.tab))
          ), () => "Closed tab"),
        }),
      },
    }),
    pane: defineCommand({
      meta: { name: "pane", description: "Manage shell panes" },
      subCommands: {
        split: defineCommand({
          meta: { name: "split", description: "Split a pane" },
          args: {
            session: { type: "string", required: true },
            direction: { type: "string", required: false, default: "right" },
            cwd: { type: "string", required: false },
            cmd: { type: "string", required: false },
            ...commonArgs,
          },
          run: async ({ args }) => runShellJsonCommand(args, async () => (
            await (await clientFromArgs(args)).splitPane(String(args.session), {
              direction: parsePaneDirection(args.direction),
              cwd: typeof args.cwd === "string" ? args.cwd : undefined,
              cmd: typeof args.cmd === "string" ? args.cmd : undefined,
            })
          ), () => "Split pane"),
        }),
        close: defineCommand({
          meta: { name: "close", description: "Close a pane" },
          args: { session: { type: "string", required: true }, pane: { type: "string", required: true }, ...commonArgs },
          run: async ({ args }) => runShellJsonCommand(args, async () => (
            await (await clientFromArgs(args)).closePane(String(args.session), String(args.pane))
          ), () => "Closed pane"),
        }),
      },
    }),
    layout: defineCommand({
      meta: { name: "layout", description: "Manage shell layouts" },
      subCommands: {
        save: defineCommand({
          meta: { name: "save", description: "Save a layout" },
          args: { name: { type: "string", required: true }, kdl: { type: "string", required: true }, ...commonArgs },
          run: async ({ args }) => runShellJsonCommand(args, async () => (
            await (await clientFromArgs(args)).saveLayout(String(args.name), String(args.kdl))
          ), () => "Saved layout"),
        }),
        ls: defineCommand({
          meta: { name: "ls", description: "List layouts" },
          args: commonArgs,
          run: async ({ args }) => runShellJsonCommand(args, async () => ({
            layouts: await (await clientFromArgs(args)).listLayouts(),
          }), () => "Listed layouts"),
        }),
        show: defineCommand({
          meta: { name: "show", description: "Show a layout" },
          args: { name: { type: "string", required: true }, ...commonArgs },
          run: async ({ args }) => runShellJsonCommand(args, async () => (
            await (await clientFromArgs(args)).showLayout(String(args.name))
          ), () => "Showed layout"),
        }),
        apply: defineCommand({
          meta: { name: "apply", description: "Apply a layout" },
          args: { session: { type: "string", required: true }, name: { type: "string", required: true }, ...commonArgs },
          run: async ({ args }) => runShellJsonCommand(args, async () => (
            await (await clientFromArgs(args)).applyLayout(String(args.session), String(args.name))
          ), () => "Applied layout"),
        }),
        dump: defineCommand({
          meta: { name: "dump", description: "Dump a session layout" },
          args: { session: { type: "string", required: true }, ...commonArgs },
          run: async ({ args }) => runShellJsonCommand(args, async () => (
            await (await clientFromArgs(args)).dumpLayout(String(args.session))
          ), () => "Dumped layout"),
        }),
        rm: defineCommand({
          meta: { name: "rm", description: "Delete a layout" },
          args: { name: { type: "string", required: true }, ...commonArgs },
          run: async ({ args }) => runShellJsonCommand(args, async () => (
            await (await clientFromArgs(args)).deleteLayout(String(args.name))
          ), () => "Deleted layout"),
        }),
      },
    }),
  },
  run: ({ rawArgs }) => {
    if (!hasShellSubCommand(rawArgs)) {
      console.log(SHELL_USAGE);
    }
  },
});
