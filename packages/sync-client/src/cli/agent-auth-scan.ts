import { access } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";

export type AgentAuthProvider =
  | "codex"
  | "claude-code"
  | "claude-code-keychain"
  | "opencode"
  | "opencode-config"
  | "pi";

export interface AgentAuthScanEntry {
  provider: AgentAuthProvider;
  status: "found" | "missing" | "manual";
  localPath: string;
  remotePath: string | null;
  transferable: boolean;
}

export interface AgentAuthScanResult {
  providers: AgentAuthScanEntry[];
}

export interface AgentAuthScanOptions {
  homeDir?: string;
  includeMacOsKeychainHint?: boolean;
}

interface TransferableProvider {
  provider: Extract<AgentAuthProvider, "codex" | "claude-code" | "opencode" | "pi">;
  localPath: string;
  remotePath: string;
}

const TRANSFERABLE_PROVIDERS: TransferableProvider[] = [
  {
    provider: "codex",
    localPath: ".codex/auth.json",
    remotePath: ".codex/auth.json",
  },
  {
    provider: "claude-code",
    localPath: ".claude/.credentials.json",
    remotePath: ".claude/.credentials.json",
  },
  {
    provider: "opencode",
    localPath: ".local/share/opencode/auth.json",
    remotePath: ".local/share/opencode/auth.json",
  },
  {
    provider: "pi",
    localPath: ".pi/agent/auth.json",
    remotePath: ".pi/agent/auth.json",
  },
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw err;
  }
}

function displayPath(relativePath: string): string {
  return `~/${relativePath}`;
}

export async function scanAgentAuth(options: AgentAuthScanOptions = {}): Promise<AgentAuthScanResult> {
  const homeDir = options.homeDir ?? homedir();
  const providers: AgentAuthScanEntry[] = [];

  for (const candidate of TRANSFERABLE_PROVIDERS) {
    const found = await exists(join(homeDir, candidate.localPath));
    providers.push({
      provider: candidate.provider,
      status: found ? "found" : "missing",
      localPath: displayPath(candidate.localPath),
      remotePath: candidate.remotePath,
      transferable: found,
    });
  }

  const includeKeychainHint = options.includeMacOsKeychainHint ?? platform() === "darwin";
  if (includeKeychainHint) {
    providers.push({
      provider: "claude-code-keychain",
      status: "manual",
      localPath: "macOS Keychain: Claude Code-credentials",
      remotePath: null,
      transferable: false,
    });
  }

  if (await exists(join(homeDir, ".config/opencode/opencode.json"))) {
    providers.push({
      provider: "opencode-config",
      status: "manual",
      localPath: "~/.config/opencode/opencode.json",
      remotePath: null,
      transferable: false,
    });
  }

  return { providers };
}
