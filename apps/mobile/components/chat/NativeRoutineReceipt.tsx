import {useState} from "react";
import {Text,View} from "react-native";
import {StyleSheet} from "react-native-unistyles";
import type {RoutineChatReceiptPart} from "@matrix-os/contracts";
import {routineReceiptOutcome} from "@matrix-os/ui/routine-origin";
import {Button} from "@/components/ui";
import {NativeScheduledMessageMeta} from "./NativeScheduledMessageMeta";
export function NativeRoutineReceipt({receipt,text,sourceChatId,onOpenChat}:{receipt:RoutineChatReceiptPart;text:string;sourceChatId?:string;onOpenChat?:(chatId:string)=>void}) {
 const [expanded,setExpanded]=useState(false);
 return <View accessibilityLabel="Scheduled task result" style={styles.card}><NativeScheduledMessageMeta timestamp={receipt.scheduledFor} sent={false}/><Text style={styles.text}>{routineReceiptOutcome(receipt)}</Text><Text selectable style={styles.text}>{text||"Output unavailable. Open execution history for details."}</Text><Text style={styles.text}>{`Matrix routine · ${receipt.model}`}</Text><Button variant="text" label={expanded?"Hide execution details":"Execution details"} onPress={()=>setExpanded(value=>!value)}/>{expanded?<Text style={styles.text}>{`Source Chat: ${sourceChatId??"This Chat"}\nExecutor Chat: ${receipt.canonicalChatId}\nTask: ${receipt.canonicalTaskId}\nRoutine: ${receipt.routineId}\nOccurrence: ${receipt.fireId} · attempt ${receipt.attempt}`}</Text>:null}{onOpenChat?<Button variant="text" label="Open execution history" onPress={()=>onOpenChat(receipt.canonicalChatId)}/>:null}</View>;
}
const styles=StyleSheet.create(theme=>({card:{gap:8,padding:12,borderWidth:1,borderRadius:12,borderColor:theme.colors.border},text:{color:theme.colors.foreground}}));
