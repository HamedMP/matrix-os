export type RunMode = "chat" | "setup";
export type RunStatus = "queued" | "running" | "completed" | "failed";

export interface HostedBotSummary { id: string; name: string; description: string }
export interface HostedBot extends HostedBotSummary { revision: number; instructions: string }
export interface HostedBotThread { id: string; title: string; updatedAt: string }
export interface HostedBotRun {
  id: string;
  status: RunStatus;
  mode: RunMode;
  createdAt: string;
  completedAt: string | null;
}
export interface HostedBotMessage { id: string; role: "user" | "assistant"; text: string; createdAt: string }
export interface HostedBotChange { id: string; reason: string; revision: number; undoneAt: string | null }
export interface RunInput { requestId: string; text: string; mode: RunMode }
export interface ModelInput {
  mode: RunMode;
  instructions: string;
  messages: ReadonlyArray<Pick<HostedBotMessage, "role" | "text">>;
}
export interface ModelResult { text: string; profile?: { reason: string; instructions: string } }

export class HostedBotsError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "limit" | "model_required") {
    super(code);
  }
}
