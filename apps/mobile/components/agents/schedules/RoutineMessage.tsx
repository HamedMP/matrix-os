import {Pressable,Text,View} from "react-native";
import {StyleSheet,useUnistyles} from "react-native-unistyles";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import {routineOccurrenceTime,type RoutineOccurrence} from "@matrix-os/ui/bot-routine-transcript";
import {Icon} from "@/components/ui";

export function NativeRoutineMessageMeta({occurrence,sent=true}:{occurrence:RoutineOccurrence;sent?:boolean}){
  const {theme}=useUnistyles();
  return <View style={styles.meta}>
    <Icon icon={Clock01Icon} size={14} color={theme.v2.colors.textSubtle}/>
    <Text style={styles.note}>{sent?"Sent by scheduled task":"Scheduled task"}</Text>
    <Text style={styles.note}>{routineOccurrenceTime(occurrence)}</Text>
  </View>;
}
export function NativeRoutineMessageReadNotice({failed,incomplete,retry,loading}:{failed:boolean;incomplete:boolean;retry:()=>void;loading:boolean}){
  return failed?<View><Text style={styles.note}>Scheduled task status could not be loaded.</Text><Pressable accessibilityRole="button" accessibilityLabel="Retry scheduled task status" disabled={loading} accessibilityState={{disabled:loading}} onPress={retry}><Text style={styles.note}>Retry</Text></Pressable></View>
    :incomplete?<Text style={styles.note}>Scheduled task status is limited to the recent saved runs.</Text>:null;
}
const styles=StyleSheet.create(theme=>({
  meta:{flexDirection:"row",justifyContent:"flex-end",alignItems:"center",flexWrap:"wrap",gap:theme.v2.space[6]},
  note:{...theme.v2.text.footnote,color:theme.v2.colors.textSubtle},
}));
