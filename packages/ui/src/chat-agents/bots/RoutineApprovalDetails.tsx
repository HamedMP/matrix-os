import { chatAgentMutedStyle } from "../theme.js";
import { routineScheduleCopy, ROUTINE_EXECUTION_IMPACT, type routineApprovalPreview } from "./routine-presentation.js";

export function RoutineApprovalDetails({ approval, agentName, preview, historical = false }: {
  approval: NonNullable<ReturnType<typeof routineApprovalPreview>>; agentName?: string; preview: string; historical?: boolean;
}) {
  const { proposal, source } = approval, schedule = routineScheduleCopy(proposal.schedule);
  const fields: [string, string][] = [["Bot", agentName ?? "This Bot"], ["Model", proposal.selection.model], ["Computer", source.computerId],
    ["When", schedule.frequency], ["Time zone", schedule.timezone]];
  if (!historical) {
    const estimate = approval.estimatedNextFireAt;
    const zone = proposal.schedule.kind === "cron" ? proposal.schedule.tz : "UTC";
    fields.push(estimate ? ["Estimated next run", new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(new Date(estimate)) + (proposal.schedule.kind === "cron" ? "" : " UTC")]
      : ["First run", schedule.next]);
  }
  fields.push(["Access", proposal.authorizedEffects.map(effect => ({ read: "Read", write: "Create or change content", send: "Send messages" })[effect]).join(", ")]);
  return <>
    <p className="whitespace-pre-wrap break-words text-sm leading-6">{proposal.prompt}</p>
    <dl className="grid min-w-0 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {fields.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs" style={chatAgentMutedStyle}>{label}</dt><dd className="break-words">{value}</dd></div>)}
    </dl>
    {!historical ? <>
      <p className="text-xs leading-5" style={chatAgentMutedStyle}>{ROUTINE_EXECUTION_IMPACT}</p>
      {approval.estimatedNextFireAt ? <p className="text-xs" style={chatAgentMutedStyle}>Next run is recalculated when you approve.</p> : null}
      <p className="text-xs leading-5" style={chatAgentMutedStyle}>Pause or archive this task in Schedules at any time.</p>
    </> : null}
    <details className="min-w-0 text-xs"><summary className="cursor-pointer font-medium">Technical details</summary>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{preview}</pre>
    </details>
  </>;
}
