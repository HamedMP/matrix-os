import { defineCommand } from "citty";
import { loadProfileAuth } from "../../auth/token-store.js";
import { resolveCliProfile } from "../profiles.js";
import { formatCliError, formatCliSuccess } from "../output.js";
import { createShellClient } from "../shell-client.js";

async function clientFromArgs(args: Record<string, unknown>) {
  const profile = await resolveCliProfile(args);
  const auth = profile.token ? null : await loadProfileAuth(profile.name);
  const token = profile.token ?? auth?.accessToken;
  return createShellClient({ gatewayUrl: profile.gatewayUrl, token });
}

function writeError(err: unknown, json: boolean): void {
  const code =
    err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : "request_failed";
  const output = json ? formatCliError(code) : `Error: Request failed (${code})`;
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
    ls: defineCommand({
      meta: { name: "ls", description: "List shell sessions" },
      args: {
        profile: { type: "string", required: false },
        dev: { type: "boolean", required: false, default: false },
        gateway: { type: "string", required: false },
        token: { type: "string", required: false },
        json: { type: "boolean", required: false, default: false },
      },
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
              const name =
                typeof session === "object" && session !== null && "name" in session
                  ? String((session as { name: unknown }).name)
                  : String(session);
              console.log(name);
            }
          }
        } catch (err) {
          writeError(err, json);
          process.exitCode = 1;
        }
      },
    }),
    new: defineCommand({
      meta: { name: "new", description: "Create a shell session" },
      args: {
        name: { type: "positional", required: true },
        cwd: { type: "string", required: false },
        layout: { type: "string", required: false },
        cmd: { type: "string", required: false },
        profile: { type: "string", required: false },
        dev: { type: "boolean", required: false, default: false },
        gateway: { type: "string", required: false },
        token: { type: "string", required: false },
        json: { type: "boolean", required: false, default: false },
      },
      run: async ({ args }) => {
        const json = args.json === true;
        try {
          const data = await (await clientFromArgs(args)).createSession({
            name: String(args.name),
            cwd: typeof args.cwd === "string" ? args.cwd : undefined,
            layout: typeof args.layout === "string" ? args.layout : undefined,
            cmd: typeof args.cmd === "string" ? args.cmd : undefined,
          });
          console.log(json ? formatCliSuccess(data) : `Created shell session ${args.name}`);
        } catch (err) {
          writeError(err, json);
          process.exitCode = 1;
        }
      },
    }),
    attach: defineCommand({
      meta: { name: "attach", description: "Attach to a shell session" },
      args: {
        name: { type: "positional", required: true },
        fromSeq: { type: "string", required: false },
        profile: { type: "string", required: false },
        dev: { type: "boolean", required: false, default: false },
        gateway: { type: "string", required: false },
        token: { type: "string", required: false },
        json: { type: "boolean", required: false, default: false },
      },
      run: async ({ args }) => {
        const json = args.json === true;
        try {
          const fromSeq =
            typeof args.fromSeq === "string" && /^\d+$/.test(args.fromSeq)
              ? Number(args.fromSeq)
              : undefined;
          const result = await (await clientFromArgs(args)).attachSession(String(args.name), {
            fromSeq,
          });
          console.log(
            json
              ? formatCliSuccess({ detached: result.detached })
              : `Detached. Reattach: matrix shell attach ${args.name}`,
          );
        } catch (err) {
          writeError(err, json);
          process.exitCode = 1;
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
            await (await clientFromArgs(args)).switchTab(String(args.session), Number(args.tab))
          ), () => "Switched tab"),
        }),
        close: defineCommand({
          meta: { name: "close", description: "Close tab" },
          args: { session: { type: "string", required: true }, tab: { type: "string", required: true }, ...commonArgs },
          run: async ({ args }) => runShellJsonCommand(args, async () => (
            await (await clientFromArgs(args)).closeTab(String(args.session), Number(args.tab))
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
              direction: args.direction === "down" ? "down" : "right",
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
  run: () => {
    console.log("Usage: matrix shell ls|new|attach|rm");
  },
});
