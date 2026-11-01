import { chatAgentMutedStyle } from "../theme.js";
import { routineScheduleCopy, ROUTINE_EXECUTION_IMPACT, type routineApprovalPreview } from "./routine-presentation.js";

export function RoutineApprovalDetails({ approval, agentName, preview }: {
  approval: NonNullable<ReturnType<typeof routineApprovalPreview>>; agentName?: string; preview: string;
}) {
  const { proposal, source } = approval, schedule = routineScheduleCopy(proposal.schedule);
  return <>
    <p className="whitespace-pre-wrap break-words text-sm leading-6">{proposal.prompt}</p>
    <dl className="grid min-w-0 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {[["Bot", agentName ?? "This Bot"], ["Computer", source.computerId], ["When", schedule.frequency],
        ["Time zone", schedule.timezone], [approval.estimatedNextFireAt ? "Estimated next run" : "First run", approval.estimatedNextFireAt ? new Intl.DateTimeFormat("en", {dateStyle: "medium", timeStyle: "short", timeZone: proposal.schedule.kind === "cron" ? proposal.schedule.tz : "UTC"}).format(new Date(approval.estimatedNextFireAt)) + (proposal.schedule.kind === "cron" ? "" : " UTC") : schedule.next], ["Access", proposal.authorizedEffects.map(effect => ({ read: "Read", write: "Create or change content", send: "Send messages" })[effect]).join(", ")]]
        .map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs" style={chatAgentMutedStyle}>{label}</dt><dd className="break-words">{value}</dd></div>)}
    </dl>
    <p className="text-xs leading-5" style={chatAgentMutedStyle}>{ROUTINE_EXECUTION_IMPACT}</p>
    {approval.estimatedNextFireAt ? <p className="text-xs" style={chatAgentMutedStyle}>Next run is recalculated when you approve.</p> : null}
    <p className="text-xs leading-5" style={chatAgentMutedStyle}>Pause or archive this task in Schedules at any time.</p>
    <details className="min-w-0 text-xs"><summary className="cursor-pointer font-medium">Technical details</summary>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{preview}</pre>
    </details>
  </>;
}
