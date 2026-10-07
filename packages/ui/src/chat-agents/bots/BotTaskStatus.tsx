import { botTaskStatusCopy, type BotTaskSummary } from "@matrix-os/contracts";
import { chatAgentMutedStyle } from "../theme.js";

export function BotTaskStatus({ task }: { task: BotTaskSummary }) {
  return <p role="status" className="text-xs" style={chatAgentMutedStyle}>{botTaskStatusCopy(task)}</p>;
}
