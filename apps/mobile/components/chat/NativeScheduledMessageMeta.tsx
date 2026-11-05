import {Text,View} from "react-native";
import {StyleSheet,useUnistyles} from "react-native-unistyles";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import {scheduledMessageTime,type ScheduledMessagePresentation} from "@matrix-os/ui/chat-scheduled-message";
import {Icon} from "@/components/ui";
export function NativeScheduledMessageMeta({timestamp,sent=true}:ScheduledMessagePresentation&{sent?:boolean}) {
 const {theme}=useUnistyles();return <View style={styles.meta}><Icon icon={Clock01Icon} size={14} color={theme.v2.colors.textSubtle}/><Text style={styles.text}>{sent?"Sent by scheduled task":"Scheduled task"}</Text><Text style={styles.text}>{scheduledMessageTime(timestamp)}</Text></View>;
}
const styles=StyleSheet.create(theme=>({meta:{flexDirection:"row",flexWrap:"wrap",justifyContent:"flex-end",gap:6},text:{...theme.v2.text.caption,color:theme.v2.colors.textSubtle}}));
