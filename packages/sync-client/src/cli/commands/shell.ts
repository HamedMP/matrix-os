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
  },
  run: () => {
    console.log("Usage: matrix shell ls|new|attach|rm");
  },
});
