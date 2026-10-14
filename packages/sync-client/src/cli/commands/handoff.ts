import { stat, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { defineCommand } from "citty";
import { createLocalChatHttpTransport, uploadLocalChatArchive } from "@matrix-os/contracts/local-chat-import";
import { openBrowser } from "../../auth/oauth.js";
import { discoverLocalChatFiles } from "../../import/discovery.js";
import { openLocalChatSource } from "../../import/local-chat-source.js";
import { requireCliAuthToken } from "../auth-state.js";
import { expandLocalPath } from "../file-transfer-client.js";
import { HandoffApiError, createHandoffGateway } from "../handoff/gateway-api.js";
import { HandoffGitError } from "../handoff/git-local.js";
import {
  HandoffError,
  runHandoff,
  type HandoffAgent,
  type HandoffPreview,
  type HandoffResult,
  type TranscriptChoice,
} from "../handoff/run-handoff.js";
import { formatCliError, formatCliSuccess } from "../output.js";
import { resolveCliProfile } from "../profiles.js";

const API_ERROR_TEXT: Record<string, string> = {
  not_authenticated: "Sign in with `matrix login`, then retry.",
  auth_expired: "Your Matrix session expired. Run `matrix login`, then retry.",
  unauthorized: "Sign in with `matrix login`, then retry.",
  github_auth_required: "Connect GitHub on Matrix (run `gh auth login` in a Matrix terminal), then retry.",
  worktree_path_conflict: "A worktree folder on Matrix needs recovery. Open the project in Matrix and remove the stale worktree, then retry.",
  rate_limited: "Matrix is rate limiting requests. Wait a minute, then retry.",
};

function defaultAgent(): HandoffAgent {
  if (process.env.CLAUDECODE === "1" || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  return "codex";
}

function display(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function formatPreview(preview: HandoffPreview): string {
  const repo = preview.repo.github ? `${preview.repo.github.owner}/${preview.repo.github.repo}` : display(preview.repo.root);
  const project = preview.project.action === "reuse"
    ? `use existing project "${preview.project.project.slug}"`
    : preview.project.action === "create_github"
      ? `create project "${preview.project.slug}" by cloning ${preview.project.url}`
      : `create project "${preview.project.slug}" from an upload of this repository`;
  const lines = [
    "Matrix handoff preview",
    `  Repository:  ${repo} @ ${preview.branch}${preview.repo.branchIsSynthetic ? " (detached HEAD)" : ""}`,
    `  Project:     ${project}`,
    `  Work:        ${preview.unpushedCommits} commit(s) not on origin, ${preview.snapshot.changedPaths.length} uncommitted file change(s)`,
  ];
  if (preview.snapshot.withheldPaths.length) {
    lines.push(`  Withheld:    ${preview.snapshot.withheldPaths.slice(0, 8).join(", ")}${preview.snapshot.withheldPaths.length > 8 ? ", …" : ""}`);
  }
  lines.push(
    `  Transcript:  ${preview.transcript ? `${display(preview.transcript.path)} (${mib(preview.transcript.bytes)}) → private Chat` : "not included"}`,
    `  Agent:       ${preview.instance.displayName ?? preview.instance.id} · ${preview.selection.model} · ${preview.permissionMode}`,
    `  Chat title:  ${preview.title}`,
    "  Never sent:  .git credentials, .env files, keys and other secret-looking files. Nothing is pushed to GitHub.",
  );
  if (preview.transcript) {
    lines.push("  Note:        the raw transcript can contain anything pasted into that session. Use --history none to leave it out.");
  }
  return lines.join("\n");
}

function formatResult(result: HandoffResult): string {
  const where = result.executionRoot.kind === "worktree" ? `worktree on ${result.branch}` : `project root on ${result.branch}`;
  const lines = [
    "",
    "Handoff ready.",
    `  Project:  ${result.projectSlug} (${where})`,
    `  Chat:     ${result.url}`,
  ];
  if (result.usedSideBranch) lines.push(`  Note:     the Matrix copy of your branch had other work, so this landed on ${result.branch}.`);
  if (result.transcriptChatId) lines.push(`  History:  imported as private Chat ${result.transcriptChatId}`);
  return lines.join("\n");
}

async function discoverTranscript(root: string): Promise<TranscriptChoice | null> {
  const result = await discoverLocalChatFiles({ project: root, signal: AbortSignal.timeout(60_000) });
  const candidates = result.files.filter((file) => file.association === "matched" && file.sourceKind === "active").slice(0, 200);
  let best: TranscriptChoice | null = null;
  for (const file of candidates) {
    try {
      const info = await stat(file.path);
      if (!best || info.mtimeMs > best.modifiedMs) best = { path: file.path, harness: file.harness, bytes: info.size, modifiedMs: info.mtimeMs };
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return best;
}

function historyOption(value: unknown): "auto" | "none" | { path: string; harness: "codex" | "claude" } {
  if (value === undefined || value === "auto") return "auto";
  if (value === "none") return "none";
  const path = expandLocalPath(String(value));
  const harness = path.includes("/.claude/") ? "claude" : path.includes("/.codex/") ? "codex" : null;
  if (!harness) throw new HandoffError("--history must be auto, none, or a transcript under ~/.claude or ~/.codex.", "invalid_history");
  return { path, harness };
}

async function confirmInteractively(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question("\nHand off to Matrix now? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function errorText(error: unknown): { code: string; message: string } {
  if (error instanceof HandoffError || error instanceof HandoffGitError) return { code: error.code, message: error.message };
  if (error instanceof HandoffApiError) {
    return { code: error.code, message: API_ERROR_TEXT[error.code] ?? `Matrix rejected the request (${error.code}). Retry, or run \`matrix doctor\`.` };
  }
  if (error instanceof Error && "code" in error && ["not_authenticated", "auth_expired"].includes(String(error.code))) {
    return { code: String(error.code), message: API_ERROR_TEXT[String(error.code)]! };
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { code: "timeout", message: "Matrix did not answer in time. Check your connection and retry; the handoff is safe to re-run." };
  }
  return { code: "handoff_failed", message: "The handoff failed. Re-run with MATRIX_CLI_DEBUG=1 for details; it is safe to retry." };
}

export const handoffCommand = defineCommand({
  meta: {
    name: "handoff",
    description: "Move the current repository and task to your Matrix computer as a project Chat",
  },
  args: {
    agent: { type: "string", required: false, description: "Agent to continue in Matrix: codex or claude (default: the agent running this command, else codex)" },
    brief: { type: "string", required: false, description: "Markdown file with the continuation brief (goal, progress, next steps)" },
    message: { type: "string", required: false, description: "Continuation brief as text instead of a file" },
    title: { type: "string", required: false, description: "Chat title" },
    history: { type: "string", required: false, description: "Transcript to import as a private Chat: auto (default), none, or a .jsonl path" },
    permission: { type: "string", required: false, description: "Chat permission mode: supervised (default), auto_accept_edits, auto, full_access" },
    approve: { type: "string", required: false, description: "Approval token printed by the preview" },
    open: { type: "boolean", default: true, description: "Open the Chat in the browser when done (interactive terminals only)" },
    profile: { type: "string", required: false },
    dev: { type: "boolean", default: false },
    gateway: { type: "string", required: false },
    token: { type: "string", required: false },
    json: { type: "boolean", default: false },
  },
  run: async ({ args }) => {
    const json = args.json === true;
    const interactive = !json && !args.approve && process.stdin.isTTY === true && process.stderr.isTTY === true;
    try {
      const agent = typeof args.agent === "string" ? args.agent : defaultAgent();
      if (agent !== "codex" && agent !== "claude") throw new HandoffError("--agent must be codex or claude.", "invalid_agent");
      if (typeof args.brief === "string" && typeof args.message === "string") {
        throw new HandoffError("Use either --brief or --message, not both.", "invalid_brief");
      }
      const brief = typeof args.brief === "string"
        ? await readFile(expandLocalPath(args.brief), "utf8")
        : typeof args.message === "string" ? args.message : null;
      const profile = await resolveCliProfile(args);
      const token = await requireCliAuthToken(profile);
      const gateway = createHandoffGateway({ gatewayUrl: profile.gatewayUrl, token });
      const log = (line: string) => {
        if (!json) console.error(line);
      };
      const { preview, result } = await runHandoff(
        {
          cwd: process.cwd(),
          agent,
          brief,
          ...(typeof args.title === "string" ? { title: args.title } : {}),
          history: historyOption(args.history),
          ...(typeof args.permission === "string" ? { permissionMode: args.permission } : {}),
          ...(typeof args.approve === "string" ? { approvalToken: args.approve } : {}),
          gatewayUrl: profile.gatewayUrl,
        },
        {
          gateway,
          discoverTranscript,
          importTranscript: async (choice, title) => {
            const source = await openLocalChatSource(choice.path);
            try {
              const signal = AbortSignal.timeout(10 * 60_000);
              const transcript = await source.preview(choice.harness, signal);
              const transport = createLocalChatHttpTransport({ baseUrl: profile.gatewayUrl, headers: () => ({ authorization: `Bearer ${token}` }) });
              const imported = await uploadLocalChatArchive({
                harness: choice.harness,
                sourceId: transcript.sourceId,
                ...(transcript.sourceAgentId ? { sourceAgentId: transcript.sourceAgentId } : {}),
                sourceHash: transcript.sourceHash,
                rawSize: transcript.rawBytes,
                title: title.slice(0, 160),
              }, source, transport, { signal });
              return { chatId: imported.chatId };
            } finally {
              await source.close();
            }
          },
          now: () => new Date(),
          log,
        },
        async (planned) => {
          if (!interactive) return false;
          console.error(formatPreview(planned));
          return await confirmInteractively();
        },
      );
      if (!result) {
        if (json) {
          console.log(formatCliSuccess({ applied: false, approvalToken: preview.approvalToken, preview: summarize(preview) }));
        } else if (!interactive) {
          console.log(`${formatPreview(preview)}\n\nNothing has been uploaded. To hand off exactly this, run:\n  matrix handoff ${reproduceArgs({ ...args, agent })}--approve ${preview.approvalToken}`);
        } else {
          console.error("Handoff cancelled. Nothing was uploaded.");
        }
        return;
      }
      if (json) {
        console.log(formatCliSuccess({ applied: true, ...result }));
        return;
      }
      console.log(formatResult(result));
      if (args.open !== false && process.stdout.isTTY) openBrowser(result.url);
    } catch (error: unknown) {
      if (process.env.MATRIX_CLI_DEBUG === "1") console.error("[handoff]", error);
      const { code, message } = errorText(error);
      console.error(json ? formatCliError(code, message) : message);
      process.exitCode = 1;
    }
  },
});

function summarize(preview: HandoffPreview) {
  return {
    repository: preview.repo.github ?? { name: preview.repo.name },
    branch: preview.branch,
    project: preview.project.action === "reuse" ? { action: "reuse", slug: preview.project.project.slug } : preview.project,
    unpushedCommits: preview.unpushedCommits,
    changedPaths: preview.snapshot.changedPaths.length,
    withheldPaths: preview.snapshot.withheldPaths,
    transcript: preview.transcript ? { path: preview.transcript.path, bytes: preview.transcript.bytes } : null,
    agent: preview.instance.id,
    model: preview.selection.model,
    permissionMode: preview.permissionMode,
    title: preview.title,
  };
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Re-states the preview's options so the approval command covers the same scope. */
function reproduceArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["agent", "brief", "message", "title", "history", "permission", "profile", "gateway"]) {
    if (typeof args[key] === "string") parts.push(`--${key} ${quote(args[key] as string)}`);
  }
  if (args.dev === true) parts.push("--dev");
  return parts.length ? `${parts.join(" ")} ` : "";
}
