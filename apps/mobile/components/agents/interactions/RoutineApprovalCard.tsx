import { useState } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { routineApprovalPreview, routineScheduleCopy, ROUTINE_EXECUTION_IMPACT } from "@matrix-os/ui/bot-routine-presentation";
import { Button } from "@/components/ui";
import { InteractionCard, InteractionNote } from "./InteractionCard";

/** Display only: decisions still go through the designated owner/revision endpoint. */
export function RoutineApprovalCard({ preview, sending, error, stale, closed, historicalStatus, onAllow, onDeny, testID, botId }: {
  preview: string; sending: string | null; error: string | null; stale: boolean; closed?: string; historicalStatus?: string;
  onAllow(): void; onDeny(): void; testID: string; botId: string;
}) {
  const [technical, setTechnical] = useState(false);
  const approval = routineApprovalPreview(preview);
  const timing = approval ? routineScheduleCopy(approval.proposal.schedule) : null;
  const edit = Boolean(approval?.source.routineId);
  const timezone = approval?.proposal.schedule.kind === "cron" ? approval.proposal.schedule.tz : "UTC";
  const estimate = historicalStatus ? undefined : approval?.estimatedNextFireAt;
  const next = estimate ? new Intl.DateTimeFormat("en", {
    dateStyle: "medium", timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(estimate)) : timing?.next;
  const closedStatus = historicalStatus ?? closed;
  return <InteractionCard testID={testID} label={historicalStatus ? "Schedule approval" : "Needs your approval"}
    title={approval ? `${edit ? "Update schedule" : "Schedule"} ${approval.proposal.name}` : "Schedule unavailable"} error={error}>
    {approval && timing ? <>
      <InteractionNote>{approval.proposal.prompt}</InteractionNote>
      <InteractionNote>{`Bot: ${botId}`}</InteractionNote>
      <InteractionNote>{`Model: ${approval.proposal.selection.model}`}</InteractionNote>
      <InteractionNote>{`Computer: ${approval.source.computerId}`}</InteractionNote>
      <InteractionNote>{timing.frequency}</InteractionNote><InteractionNote>{timing.timezone}</InteractionNote>
      {!historicalStatus ? <InteractionNote>{`${approval.estimatedNextFireAt ? "Estimated next run" : "First run"}: ${next}`}</InteractionNote> : null}
      <InteractionNote>{`Access: ${approval.proposal.authorizedEffects.map(effect => ({ read: "Read", write: "Create or change content", send: "Send messages" })[effect]).join(", ")}`}</InteractionNote>
      {!historicalStatus ? <>
        <InteractionNote>{ROUTINE_EXECUTION_IMPACT}</InteractionNote>
        <InteractionNote>Pause or archive this task in Schedules at any time. Next run is recalculated when you approve.</InteractionNote>
      </> : null}
    </> : <InteractionNote>Schedule details are unavailable. Cancel this request and ask for a new proposal.</InteractionNote>}
    {closedStatus ? <InteractionNote>{closedStatus}</InteractionNote> : <>
      {stale ? <InteractionNote>The current schedule revision is unavailable or changed. Cancel this review and refresh before reviewing again.</InteractionNote> : null}
      {approval ? <Button label={edit ? "Approve changes" : "Approve schedule"} fullWidth size="large"
        loading={sending === "approve"} disabled={stale || sending !== null} onPress={onAllow} /> : null}
      <Button label="Cancel" variant="outline" fullWidth loading={sending === "deny"} disabled={sending !== null} onPress={onDeny} />
    </>}
    <Button label={technical ? "Hide technical details" : "Technical details"} variant="text" onPress={() => setTechnical(value => !value)} />
    {technical ? <Text selectable style={styles.technical}>{preview.slice(0, 32 * 1024)}</Text> : null}
  </InteractionCard>;
}

const styles = StyleSheet.create(theme => ({ technical: { ...theme.v2.text.caption, color: theme.v2.colors.textDefault } }));
