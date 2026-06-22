export type DesktopUpdateChannel = "stable" | "beta" | "canary" | "dev";

export type UpdateFeedConfig =
  | {
      enabled: false;
      channel: DesktopUpdateChannel;
      allowPrerelease: boolean;
    }
  | {
      enabled: true;
      provider: "generic";
      url: string;
      channel: DesktopUpdateChannel;
      allowPrerelease: boolean;
    }
  | {
      enabled: true;
      provider: "github";
      owner: string;
      repo: string;
      channel: DesktopUpdateChannel;
      allowPrerelease: boolean;
    };

const DEFAULT_OWNER = "HamedMP";
const DEFAULT_REPO = "matrix-os";

declare const __MATRIX_DESKTOP_UPDATE_CHANNEL__: string | undefined;

function buildUpdateChannel(): string | undefined {
  return typeof __MATRIX_DESKTOP_UPDATE_CHANNEL__ === "string"
    ? __MATRIX_DESKTOP_UPDATE_CHANNEL__
    : undefined;
}

function normalizeChannel(value: string | undefined): DesktopUpdateChannel {
  if (value === "beta" || value === "canary" || value === "dev") return value;
  return "stable";
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function resolveUpdateFeedConfig(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
  bundledChannel: string | undefined = buildUpdateChannel(),
): UpdateFeedConfig {
  const channel = normalizeChannel(
    firstNonEmpty(env.MATRIX_DESKTOP_UPDATE_CHANNEL, env.OPERATOR_UPDATE_CHANNEL, bundledChannel),
  );
  const allowPrerelease = channel !== "stable";

  if (!isPackaged) {
    return { enabled: false, channel, allowPrerelease };
  }

  const genericUrl = firstNonEmpty(env.OPERATOR_UPDATE_FEED, env.MATRIX_DESKTOP_UPDATE_FEED);
  if (genericUrl) {
    return {
      enabled: true,
      provider: "generic",
      url: genericUrl,
      channel,
      allowPrerelease,
    };
  }

  return {
    enabled: true,
    provider: "github",
    owner: firstNonEmpty(env.MATRIX_DESKTOP_RELEASE_OWNER) ?? DEFAULT_OWNER,
    repo: firstNonEmpty(env.MATRIX_DESKTOP_RELEASE_REPO) ?? DEFAULT_REPO,
    channel,
    allowPrerelease,
  };
}
