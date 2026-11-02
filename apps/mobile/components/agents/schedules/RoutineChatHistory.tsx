import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { BotRoutineClient } from "@matrix-os/ui/bot-routine-client";
import { useRoutineChatHistory } from "@matrix-os/ui/bot-routine-history";
import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { createNativeRoutineClient } from "@/lib/requests/routines";
import { Button } from "@/components/ui";
import { scheduleStyles as styles } from "./styles";

export function RoutineChatHistory({api, chatId}: {api: BotRoutineClient; chatId: string}) {
  const [open, setOpen] = useState(false);
  const history = useRoutineChatHistory(api, chatId, open);
  return <View style={styles.group}>
    <Button label="Scheduled task history" variant="text" onPress={() => setOpen(value => !value)} />
    {open ? <>
      <View style={styles.row}><Button label="Current tasks" variant="outline" onPress={history.showCurrent}/><Button label="Archived tasks" variant="outline" onPress={history.showArchived}/><Button label="Refresh history" variant="outline" disabled={history.loading || history.detailLoading} onPress={history.refresh}/></View>
      {history.error ? <Text accessibilityRole="alert" style={styles.error}>{history.error}</Text> : null}
      {history.loading ? <Text style={styles.note}>Loading scheduled tasks…</Text> : null}
      {!history.loading && !history.items.length ? <Text style={styles.note}>No {history.archived ? "archived" : "current"} schedules for this Chat on this page.</Text> : null}
      {history.items.map(row => <Button key={row.routineId} label={`History for ${row.proposal.name}`} variant="text" onPress={() => history.select(row.routineId)}/>)}
      {history.nextCursor ? <Button label="Next history page" disabled={history.loading} onPress={history.nextPage}/> : null}
      {history.detailLoading ? <Text style={styles.note}>Loading runs…</Text> : null}
      {history.detail ? <View style={styles.group}>
        <Text accessibilityRole="header" style={styles.heading}>{history.detail.routine.proposal.name}</Text><Text style={styles.note}>Recent saved runs (up to 20).</Text>
        {!history.detail.history.length ? <Text style={styles.note}>No runs yet.</Text> : history.detail.history.map(fire => <View key={fire.fireId} style={styles.card}>
          <Text style={styles.text}>{new Date(fire.scheduledFor).toLocaleString()} · {fire.status} · {fire.attempts} attempt{fire.attempts === 1 ? "" : "s"}</Text>
          {fire.failureCode ? <Text style={styles.note}>Execution did not complete. Review this task before retrying; uncertain work is not replayed automatically.</Text> : null}
        </View>)}
      </View> : null}
    </> : null}
  </View>;
}

export function NativeRoutineChatHistory({chatId}: {chatId: string}) {
  const gateway = useActiveGateway();
  const api = useMemo(() => createNativeRoutineClient(gateway.session), [gateway.session]);
  return gateway.ready ? <RoutineChatHistory key={`${gateway.userId}:${gateway.computerKey}:${chatId}`} api={api} chatId={chatId}/> : null;
}
