import type {
  ConversationMessagePresentation,
  ConversationTurnPresentation,
  ConversationWorkPresentation,
} from "../../../desktop/src/renderer/src/components/conversation/presentation";

export type ProjectLikeConversationEvent =
  | {
      kind: "commentary";
      id: string;
      text: string;
      timestamp: number;
    }
  | {
      kind: "command";
      id: string;
      command: string;
      state: "running" | "completed" | "stopped" | "failed";
      timestamp: number;
    }
  | {
      kind: "final";
      id: string;
      text: string;
      timestamp: number;
    };

export interface ProjectLikeConversationTurn {
  id: string;
  startedAt: number;
  endedAt: number;
  active: boolean;
  userText: string;
  events: ProjectLikeConversationEvent[];
}

function message(
  id: string,
  role: "user" | "assistant",
  phase: "commentary" | "final",
  markdown: string,
  timestamp: number,
): ConversationMessagePresentation {
  return { kind: "message", id, role, phase, markdown, copyText: markdown, timestamp };
}

export function adaptProjectLikeConversation(
  sourceTurns: readonly ProjectLikeConversationTurn[],
): ConversationTurnPresentation[] {
  return sourceTurns.map((source) => {
    const work: ConversationWorkPresentation[] = [];
    let final: ConversationMessagePresentation | undefined;

    for (const event of source.events) {
      if (event.kind === "commentary") {
        work.push(message(event.id, "assistant", "commentary", event.text, event.timestamp));
      } else if (event.kind === "command") {
        work.push({
          kind: "activity-group",
          id: `activity:${event.id}`,
          activities: [{
            id: event.id,
            kind: "command",
            state: event.state,
            label: event.state === "running" ? "Running command" : "Ran command",
            preview: event.command,
            previewKind: "command",
            copyText: event.command,
          }],
        });
      } else {
        final = message(event.id, "assistant", "final", event.text, event.timestamp);
      }
    }

    return {
      id: source.id,
      startedAt: source.startedAt,
      endedAt: source.endedAt,
      active: source.active,
      user: message(
        `user:${source.id}`,
        "user",
        "final",
        source.userText,
        source.startedAt,
      ),
      work,
      ...(final ? { final } : {}),
    };
  });
}
