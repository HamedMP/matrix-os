import { defineCommand } from "citty";
import { requireCliAuthToken } from "../auth-state.js";
import { formatCliError, formatCliErrorMessage, formatNdjsonEvent } from "../output.js";
import { resolveCliProfile } from "../profiles.js";
import {
  parseForwardSpec,
  startPortForward,
  type PortForwardEventData,
  type PortForwardHandle,
  type StartPortForwardOptions,
} from "../port-forward.js";

type StartForward = (options: StartPortForwardOptions) => Promise<PortForwardHandle>;

const commonArgs = {
  profile: { type: "string", required: false },
  dev: { type: "boolean", required: false, default: false },
  gateway: { type: "string", required: false },
  token: { type: "string", required: false },
  json: { type: "boolean", required: false, default: false },
} as const;

function codeFromError(err: unknown): string {
  return err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : "request_failed";
}

function writeError(err: unknown, json: boolean): void {
  const code = codeFromError(err);
  const canShowErrorMessage =
    code === "not_authenticated" ||
    (code === "auth_expired" && err instanceof Error && err.message !== "Request failed");
  const safeMessage = canShowErrorMessage && err instanceof Error ? err.message : undefined;
  console.error(
    json
      ? formatCliError(code, safeMessage)
      : code === "auth_expired"
        ? formatCliErrorMessage(code, safeMessage)
        : safeMessage ?? `Error: Request failed (${code})`,
  );
}

function publicEventData(data: PortForwardEventData, profile: string, gatewayUrl: string) {
  const output: Record<string, unknown> = {
    localHost: data.localHost,
    localPort: data.localPort,
    remoteHost: data.remoteHost,
    remotePort: data.remotePort,
  };
  if (typeof data.connectionId === "number") {
    output.connectionId = data.connectionId;
  }
  if (typeof data.code === "string") {
    output.code = data.code;
  }
  if (data.connectionId === undefined && data.code === undefined) {
    output.profile = profile;
    output.gatewayUrl = gatewayUrl;
  }
  return output;
}

async function runForward(args: Record<string, unknown>): Promise<void> {
  const json = args.json === true;
  try {
    const spec = parseForwardSpec(String(args.spec));
    const profile = await resolveCliProfile(args);
    const token = await requireCliAuthToken(profile);
    const startForward = typeof args.startForward === "function"
      ? args.startForward as StartForward
      : startPortForward;

    let readyPrinted = false;
    const handle = await startForward({
      gatewayUrl: profile.gatewayUrl,
      token,
      ...spec,
      onEvent(type, data) {
        if (type === "ready") {
          readyPrinted = true;
        }
        if (json) {
          process.stdout.write(formatNdjsonEvent(type, publicEventData(data, profile.name, profile.gatewayUrl)));
        } else if (type === "ready") {
          console.log(
            `Forwarding ${data.localHost}:${data.localPort} -> ${data.remoteHost}:${data.remotePort}`,
          );
        }
      },
    });
    await handle.ready;
    if (!readyPrinted) {
      const data = {
        localHost: handle.localHost,
        localPort: handle.localPort,
        remoteHost: handle.remoteHost,
        remotePort: handle.remotePort,
      };
      if (json) {
        process.stdout.write(formatNdjsonEvent("ready", publicEventData(data, profile.name, profile.gatewayUrl)));
      } else {
        console.log(`Forwarding ${handle.localHost}:${handle.localPort} -> ${handle.remoteHost}:${handle.remotePort}`);
      }
    }

    const close = () => {
      void handle.close().catch((err: unknown) => {
        if (err instanceof Error) {
          console.error("Error: Request failed (close_failed)");
        }
      });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    try {
      await handle.closed;
    } finally {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
    }
  } catch (err: unknown) {
    writeError(err, json);
    process.exitCode = 1;
  }
}

const forwardCommand = defineCommand({
  meta: {
    name: "forward",
    description: "Forward a local loopback port to the Matrix computer",
  },
  args: {
    spec: { type: "positional", required: true },
    ...commonArgs,
  },
  run: async ({ args }) => runForward(args),
});

export const portCommand = defineCommand({
  meta: {
    name: "port",
    description: "Manage Matrix computer port forwarding",
  },
  subCommands: {
    forward: forwardCommand,
  },
});

export const forwardAliasCommand = defineCommand({
  ...forwardCommand,
  meta: {
    name: "forward",
    description: "Forward a local loopback port to the Matrix computer",
  },
});
