import { useMemo, useState } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { routineApprovalPreview, routineScheduleCopy } from "@matrix-os/ui/bot-routine-presentation";
import { Button } from "@/components/ui";
import { InteractionCard, InteractionNote } from "./InteractionCard";

/** Display only: decisions still go through the designated owner/revision endpoint. */
export function RoutineApprovalCard({ preview, sending, error, stale, closed, onAllow, onDeny, testID, botId }: {
  preview: string; sending: string | null; error: string | null; stale: boolean; closed?: string;
  onAllow(): void; onDeny(): void; testID: string; botId: string;
}) {
  const [technical, setTechnical] = useState(false);
  const approval = routineApprovalPreview(preview);
  const timing = approval ? routineScheduleCopy(approval.proposal.schedule) : null;
  const edit = Boolean(approval?.source.routineId);
  const timezone = approval?.proposal.schedule.kind === "cron" ? approval.proposal.schedule.tz : "UTC";
  const formatter = useMemo(() => new Intl.DateTimeFormat("en", {
    dateStyle: "medium", timeStyle: "short",
    timeZone: timezone,
  }), [timezone]);
  const next = approval?.estimatedNextFireAt ? formatter.format(new Date(approval.estimatedNextFireAt)) : timing?.next;
  return <InteractionCard testID={testID} label="Needs your approval"
    title={approval ? `${edit ? "Update schedule" : "Schedule"} ${approval.proposal.name}` : "Schedule unavailable"} error={error}>
    {approval && timing ? <>
      <InteractionNote>{approval.proposal.prompt}</InteractionNote>
      <InteractionNote>{`Bot: ${botId}`}</InteractionNote>
      <InteractionNote>{`Computer: ${approval.source.computerId}`}</InteractionNote>
      <InteractionNote>{timing.frequency}</InteractionNote><InteractionNote>{timing.timezone}</InteractionNote>
      <InteractionNote>{`${approval.estimatedNextFireAt ? "Estimated next run" : "First run"}: ${next}`}</InteractionNote>
      <InteractionNote>{`Access: ${approval.proposal.authorizedEffects.map(effect => ({ read: "Read", write: "Create or change content", send: "Send messages" })[effect]).join(", ")}`}</InteractionNote>
      <InteractionNote>Runs without a new message using your connected ChatGPT subscription while the connected desktop device stays online. Approving allows only this task. Other actions need their own permission.</InteractionNote>
      <InteractionNote>Pause or archive this task in Schedules at any time. Next run is recalculated when you approve.</InteractionNote>
    </> : <InteractionNote>Schedule details are unavailable. Cancel this request and ask for a new proposal.</InteractionNote>}
    {closed ? <InteractionNote>{closed}</InteractionNote> : <>
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
