import type { KernelConversationToolDisplay } from "@matrix-os/contracts";
import type {
  ConversationActivityKind,
  ConversationActivityPresentation,
  ConversationActivityState,
  ConversationMessagePresentation,
  ConversationNoticePresentation,
  ConversationTurnPresentation,
  ConversationWorkPresentation,
} from "../../components/conversation/presentation";
import { groupChatTurns, type ChatMessage } from "../../lib/chat";
import type { HermesStatus } from "../../stores/hermes-chat";
import { conversationMessageDisplay } from "./ChatResourcesPanel";

const MAX_PREVIEW_CHARS = 140;
const MAX_DETAIL_CHARS = 2_000;
const SECRET_ASSIGNMENT = /(\b(?:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL)[A-Z0-9_]*)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;
const AUTHORIZATION_VALUE = /(\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+)[^\s]+/gi;
const CREDENTIAL_URL = /(https?:\/\/[^\s:@/]+:)[^\s@/]+@/gi;

function boundedText(value: unknown, maxChars = MAX_PREVIEW_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const redacted = normalized
    .replace(SECRET_ASSIGNMENT, "$1[redacted]")
    .replace(AUTHORIZATION_VALUE, "$1[redacted]")
    .replace(CREDENTIAL_URL, "$1[redacted]@");
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars - 1)}…` : redacted;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function activityState(message: ChatMessage): ConversationActivityState {
  if (message.content.startsWith("Using ")) return "running";
  if (message.content.startsWith("Failed ")) return "failed";
  if (message.content.startsWith("Stopped ")) return "stopped";
  return "completed";
}

function stateLabel(
  state: ConversationActivityState,
  labels: { running: string; completed: string; stopped: string; failed: string },
): string {
  return labels[state];
}

function persistedActivity(
  tool: string,
  state: ConversationActivityState,
  display: KernelConversationToolDisplay,
): Omit<ConversationActivityPresentation, "id" | "state"> {
  const preview = boundedText(display.preview);
  if (display.kind === "command") {
    return {
      kind: "command",
      label: stateLabel(state, {
        running: "Running command",
        completed: "Ran command",
        stopped: "Stopped command",
        failed: "Failed command",
      }),
      ...(preview ? { preview, previewKind: "command", copyText: preview } : {}),
    };
  }
  if (display.kind === "file") {
    const editing = /write|edit|apply|patch|create/i.test(tool);
    return {
      kind: editing ? "edit" : "read",
      label: stateLabel(state, editing ? {
        running: "Editing",
        completed: "Edited files",
        stopped: "Stopped editing",
        failed: "Edit failed",
      } : {
        running: "Reading",
        completed: "Read file",
        stopped: "Stopped reading",
        failed: "Read failed",
      }),
      ...(preview ? { preview, previewKind: "path" } : {}),
    };
  }
  if (display.kind === "search") {
    return {
      kind: "search",
      label: stateLabel(state, {
        running: "Searching",
        completed: "Searched",
        stopped: "Stopped search",
        failed: "Search failed",
      }),
      ...(preview ? { preview, previewKind: "text" } : {}),
    };
  }
  return {
    kind: "tool",
    label: stateLabel(state, {
      running: `Using ${tool}`,
      completed: `Used ${tool}`,
      stopped: `Stopped ${tool}`,
      failed: `Failed ${tool}`,
    }),
    ...(preview ? { preview, previewKind: "text" } : {}),
  };
}

function inferredActivity(message: ChatMessage): Omit<ConversationActivityPresentation, "id" | "state"> {
  const tool = message.tool ?? "Tool";
  const normalized = tool.toLowerCase();
  const state = activityState(message);
  const command = boundedText(message.toolInput?.command);
  const rawPath = boundedText(message.toolInput?.file_path ?? message.toolInput?.path);
  const query = boundedText(message.toolInput?.query ?? message.toolInput?.pattern);
  const description = boundedText(message.toolInput?.description);
  let kind: ConversationActivityKind = "tool";
  let preview: string | undefined;
  let previewKind: ConversationActivityPresentation["previewKind"] = "text";
  let label: string;

  if (/bash|shell|command|terminal|exec|run/.test(normalized)) {
    kind = "command";
    preview = command ?? description;
    previewKind = "command";
    label = stateLabel(state, {
      running: "Running command",
      completed: "Ran command",
      stopped: "Stopped command",
      failed: "Failed command",
    });
  } else if (/read|view|open/.test(normalized)) {
    kind = "read";
    preview = rawPath ? basename(rawPath) : description;
    previewKind = "path";
    label = stateLabel(state, {
      running: "Reading",
      completed: "Read file",
      stopped: "Stopped reading",
      failed: "Read failed",
    });
  } else if (/grep|glob|search|find/.test(normalized) || normalized.includes("toolsearch")) {
    kind = "search";
    preview = query ?? rawPath ?? description;
    label = stateLabel(state, {
      running: "Searching",
      completed: normalized.includes("toolsearch") ? "Searched tools" : "Searched",
      stopped: "Stopped search",
      failed: "Search failed",
    });
  } else if (/write|edit|apply|patch|create/.test(normalized)) {
    kind = "edit";
    preview = rawPath ? basename(rawPath) : description;
    previewKind = "path";
    label = stateLabel(state, {
      running: "Editing",
      completed: "Edited files",
      stopped: "Stopped editing",
      failed: "Edit failed",
    });
  } else {
    preview = description ?? query ?? rawPath;
    label = stateLabel(state, {
      running: `Using ${tool}`,
      completed: `Used ${tool}`,
      stopped: `Stopped ${tool}`,
      failed: `Failed ${tool}`,
    });
  }

  const detailParts = [command, rawPath, query, description]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  const detail = detailParts.length > 1
    ? boundedText(detailParts.join("\n"), MAX_DETAIL_CHARS)
    : undefined;
  return {
    kind,
    label,
    ...(preview ? { preview, previewKind } : {}),
    ...(kind === "command" && preview ? { copyText: preview } : {}),
    ...(detail ? { detail } : {}),
  };
}

export function hermesActivityPresentation(message: ChatMessage): ConversationActivityPresentation {
  const state = activityState(message);
  const presentation = message.toolDisplay
    ? persistedActivity(message.tool ?? "Tool", state, message.toolDisplay)
    : inferredActivity(message);
  return { id: message.id, state, ...presentation };
}

function messagePresentation(
  message: ChatMessage,
  phase: "commentary" | "final",
): ConversationMessagePresentation | ConversationNoticePresentation {
  if (message.role === "system") {
    const stopped = message.content === "Stopped.";
    return {
      kind: "notice",
      id: message.id,
      phase,
      tone: stopped ? "stopped" : "failed",
      label: stopped ? "Agent work stopped" : "Agent work failed",
      markdown: message.content,
      timestamp: message.timestamp,
    };
  }
  const display = message.role === "user"
    ? conversationMessageDisplay(message.content)
    : { text: message.content, attachments: [] };
  return {
    kind: "message",
    id: message.id,
    role: message.role,
    phase,
    markdown: display.text,
    copyText: display.text,
    timestamp: message.timestamp,
    ...(display.attachments.length > 0 ? {
      attachments: display.attachments.map((label, index) => ({
        id: `${message.id}:attachment:${index}`,
        kind: "file" as const,
        label,
      })),
    } : {}),
  };
}

export function hermesConversationPresentation(
  messages: ChatMessage[],
  status: HermesStatus,
  activeRequestId: string | null,
): ConversationTurnPresentation[] {
  return groupChatTurns(messages).map((turn) => {
    const active = status !== "idle" && turn.requestId === activeRequestId;
    let finalGroupIndex = -1;
    for (let index = turn.responseGroups.length - 1; index >= 0; index -= 1) {
      if (turn.responseGroups[index]?.type === "message") {
        finalGroupIndex = index;
        break;
      }
    }

    const work: ConversationWorkPresentation[] = [];
    turn.responseGroups.forEach((group, index) => {
      if (index === finalGroupIndex) return;
      if (group.type === "tool_group") {
        work.push({
          kind: "activity-group" as const,
          id: group.messages[0]?.id ?? `${turn.id}:activities:${index}`,
          activities: group.messages.map(hermesActivityPresentation),
        });
        return;
      }
      work.push(messagePresentation(group.message, "commentary"));
    });
    const finalGroup = finalGroupIndex >= 0 ? turn.responseGroups[finalGroupIndex] : undefined;
    const final = finalGroup?.type === "message"
      ? messagePresentation(finalGroup.message, "final")
      : undefined;
    const user = turn.user
      ? messagePresentation(turn.user, "commentary")
      : undefined;

    return {
      id: turn.id,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      active,
      ...(user?.kind === "message" ? { user } : {}),
      work,
      ...(final ? { final } : {}),
    };
  });
}
