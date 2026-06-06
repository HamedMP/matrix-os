import { defineCommand } from "citty";
import { resolveCliProfile } from "../profiles.js";
import { formatCliError, formatCliErrorMessage, formatCliSuccess } from "../output.js";
import { createShellClient } from "../shell-client.js";
import type { ShellAttachOptions } from "../shell-client.js";
import { requireCliAuthToken } from "../auth-state.js";

const SHELL_USAGE = "Usage: matrix shell list|new|connect|rm|tab|pane|layout";
const SHELL_SUBCOMMANDS = new Set([
  "ls", "list",
  "new",
  "attach", "connect",
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
    (code === "auth_expired" && err instanceof Error && err.message !== "Request failed");
  const safeMessage =
    canShowErrorMessage && err instanceof Error
      ? err.message
      : undefined;
  const output = json
    ? formatCliError(code, safeMessage)
    : code === "auth_expired"
      ? formatCliErrorMessage(code, safeMessage)
      : safeMessage ?? `Error: Request failed (${code})`;
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
  if (args.noMouse === true) {
    options.mouse = false;
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
            : `Detached. Reattach: matrix shell connect ${args.name}`,
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
              : `Detached. Reattach: matrix shell connect ${args.name}`,
          );
        } catch (err) {
          writeError(err, json);
          process.exitCode = 1;
        }
      },
    }),
    attach: attachCommand("attach", "Attach to a shell session"),
    connect: attachCommand("connect", "Connect to a shell session"),
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
