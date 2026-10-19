import type { CanonicalChatApprovalDecision } from "#canonical-chat";

export const SUPERVISED_TOOL_APPROVAL_TTL_MS = 10 * 60_000;

type Risk = "low" | "medium" | "high";

interface ToolCopy {
  title: string;
  noun: string;
  summary: string;
  expired: string;
  risk: Risk;
}

const WEB_SEARCH: ToolCopy = {
  title: "Search the web",
  noun: "Web search",
  summary: "Matrix wants to search the web and read a few pages to write your brief. Nothing is sent or changed.",
  expired: "No answer within 10 minutes, so nothing was searched.",
  risk: "low",
};
const WEB_PAGE: ToolCopy = {
  title: "Open a web page",
  noun: "Web page",
  summary: "Matrix wants to open a web page and read it. Nothing is sent or changed.",
  expired: "No answer within 10 minutes, so the page was not opened.",
  risk: "low",
};
const COMMAND: ToolCopy = {
  title: "Run a command",
  noun: "Command",
  summary: "Matrix wants to run a command on your computer. Nothing runs until you allow it.",
  expired: "No answer within 10 minutes, so the command was not run.",
  risk: "high",
};
const READ_FILE: ToolCopy = {
  title: "Read a file",
  noun: "File read",
  summary: "Matrix wants to read a file. Nothing is changed.",
  expired: "No answer within 10 minutes, so the file was not read.",
  risk: "medium",
};
const UPDATE_FILE: ToolCopy = {
  title: "Update a file",
  noun: "File update",
  summary: "Matrix wants to update a file. Nothing is changed until you allow it.",
  expired: "No answer within 10 minutes, so the file was not changed.",
  risk: "high",
};
const SEARCH_FILES: ToolCopy = {
  title: "Search files",
  noun: "File search",
  summary: "Matrix wants to search files. Nothing is sent or changed.",
  expired: "No answer within 10 minutes, so files were not searched.",
  risk: "low",
};
const DELEGATED: ToolCopy = {
  title: "Delegated task",
  noun: "Delegated task",
  summary: "Matrix wants to start a delegated task. Nothing starts until you allow it.",
  expired: "No answer within 10 minutes, so the task was not started.",
  risk: "medium",
};
const REVIEW: ToolCopy = {
  title: "Review this tool request",
  noun: "Tool",
  summary: "Matrix wants to use a tool. Nothing is sent or changed until you allow it.",
  expired: "No answer within 10 minutes, so the tool was not used.",
  risk: "high",
};

const TOOLS = [WEB_SEARCH, WEB_PAGE, COMMAND, READ_FILE, UPDATE_FILE, SEARCH_FILES, DELEGATED, REVIEW];
const BY_NAME: Record<string, ToolCopy> = {
  WebSearch: WEB_SEARCH,
  web_search: WEB_SEARCH,
  WebFetch: WEB_PAGE,
  web_fetch: WEB_PAGE,
  Bash: COMMAND,
  Shell: COMMAND,
  Read: READ_FILE,
  Edit: UPDATE_FILE,
  Write: UPDATE_FILE,
  NotebookEdit: UPDATE_FILE,
  Grep: SEARCH_FILES,
  Glob: SEARCH_FILES,
  Task: DELEGATED,
  Agent: DELEGATED,
};

/** Owner-facing copy for one Claude built-in tool. The internal tool id stays off the card. */
export function supervisedToolApprovalCopy(toolName: string): ToolCopy {
  return BY_NAME[toolName] ?? REVIEW;
}

export interface SupervisedToolApprovalSource {
  title: string;
  description?: string;
  pending: boolean;
  decision?: CanonicalChatApprovalDecision;
  reason?: "expired";
  allowedDecisions: readonly CanonicalChatApprovalDecision[];
}

export type SupervisedToolApproval =
  | {
    kind: "waiting";
    title: string;
    summary: string;
    details?: string;
    bar: string;
    allowOnce: boolean;
    decline: boolean;
  }
  | { kind: "allowed"; line: string }
  | { kind: "declined"; line: string }
  | { kind: "expired"; title: string; summary: string }
  | { kind: "cancelled"; line: string };

function matchTool(title: string): ToolCopy | undefined {
  return TOOLS.find((tool) => title === tool.title || title.startsWith(`${tool.title} · `));
}

function detailsFor(tool: ToolCopy, description: string | undefined): string | undefined {
  if (!description || description === tool.summary) return undefined;
  const split = description.startsWith(`${tool.summary}\n\n`)
    ? description.slice(tool.summary.length + 2).trim()
    : description.trim();
  return split.length > 0 ? split : undefined;
}

/**
 * Composer text that asks Claude to retry an expired tool request; the owner still sends it.
 * Uses only the fixed tool name: the request subject is agent-written and must not become owner-authored text.
 */
export function supervisedToolRetryPrompt(title: string): string {
  const tool = matchTool(title);
  return tool ? `Try again: ${tool.title}` : "Try again";
}

/** Composer text after Try again: unsent text is kept, with the retry prompt added after it once. */
export function supervisedToolRetryDraft(current: string, prompt: string): string {
  const kept = current.trimEnd();
  if (!kept.trim()) return prompt;
  if (kept.endsWith(prompt)) return kept;
  return `${kept}\n\n${prompt}`;
}

/** The Desktop tool-approval card, or null when this approval is some other request. */
export function supervisedToolApproval(source: SupervisedToolApprovalSource): SupervisedToolApproval | null {
  const tool = matchTool(source.title);
  if (!tool) return null;
  if (source.pending) {
    const details = detailsFor(tool, source.description);
    return {
      kind: "waiting",
      title: source.title,
      summary: tool.summary,
      ...(details ? { details } : {}),
      bar: tool.title,
      allowOnce: source.allowedDecisions.includes("approve"),
      decline: source.allowedDecisions.includes("decline"),
    };
  }
  if (source.reason === "expired") {
    return { kind: "expired", title: source.title, summary: tool.expired };
  }
  if (source.decision === "approve") return { kind: "allowed", line: `${tool.noun} allowed` };
  if (source.decision === "decline") return { kind: "declined", line: `${tool.noun} not allowed` };
  if (source.decision === "cancel") return { kind: "cancelled", line: `${tool.noun} was not used` };
  return null;
}
