import {useMemo,useRef,useState,useLayoutEffect} from "react";
import {Linking,Text,View} from "react-native";
import {StyleSheet} from "react-native-unistyles";
import {useAuth} from "@clerk/clerk-expo";
import {fetch as expoFetch} from "expo/fetch";
import {createOwnerBrowserJsonRequest,createRoutineOriginClient,routineOriginBrowserUrl,useRoutineOrigin} from "@matrix-os/ui/routine-origin";
import {Button} from "@/components/ui";
import {RoutineApprovalCard} from "@/components/agents/interactions/RoutineApprovalCard";
export function NativeSourceChatRoutines({gatewayUrl,chatId,eligible}:{gatewayUrl:string;chatId:string;eligible:boolean}) {
 const {getToken,userId,sessionId}=useAuth(),current=useRef<object|null>(null);
 const identityKey=JSON.stringify([userId,sessionId,chatId,eligible]);
 const scope=useMemo(()=>{
  const identity={key:identityKey},gateway=new URL(gatewayUrl),runtime=gateway.searchParams.get("runtime");
  if(runtime){gateway.pathname+=`/~runtime/${runtime}`;gateway.search="";}
  // eslint-disable-next-line react-hooks/refs -- The transport invokes this callback only after the committed scope effect, never during render.
  const request=createOwnerBrowserJsonRequest(gateway.toString(),async()=>{const token=await getToken();if(current.current!==identity)throw new Error("Chat context changed");return token;},expoFetch as typeof fetch);
  return {identity,client:createRoutineOriginClient((path,method,body,options)=>{if(method!=="GET")throw new Error("Review in browser");return request({path,method,body,signal:options?.signal});})};
 },[gatewayUrl,getToken,identityKey]);useLayoutEffect(()=>{current.current=scope.identity;return()=>{current.current=null;};},[scope]);
 const state=useRoutineOrigin({client:scope.client,chatId,eligible});const [notice,setNotice]=useState<{identity:object;text:string}|null>(null);
 const message=notice?.identity===scope.identity?notice.text:"";
 const setMessage=(text:string)=>{if(current.current===scope.identity)setNotice({identity:scope.identity,text});};
 const open=async(interactionId?:string)=>{if(!eligible||current.current!==scope.identity)return;try{const gateway=new URL(gatewayUrl);const url=routineOriginBrowserUrl(gateway.origin,gateway.pathname+gateway.search,chatId,interactionId);await Linking.openURL(url);if(current.current===scope.identity)setMessage(interactionId?"Continue in your browser to review this scheduled task.":"Continue in your browser. Your draft is kept here; submit the persistent task in the same Chat there.");}catch(error:unknown){console.warn("[routine-origin] Browser unavailable",error instanceof Error?error.name:"UnknownError");if(current.current===scope.identity)setMessage("The browser could not be opened. Try again.");}};
 if(!eligible)return null;
 return <View style={styles.panel}>{state.view?.pending.map(item=><View key={item.interaction.interactionId}><RoutineApprovalCard preview={item.interaction.payload?.kind==="approval"?item.interaction.payload.preview:""} botId={item.interaction.agentId} testID={`origin-${item.interaction.interactionId}`} sending={null} error={null} stale={!state.fresh} closed="Review in your browser to respond." onAllow={()=>void open(item.interaction.interactionId)} onDeny={()=>void open(item.interaction.interactionId)}/><Button label="Review in browser" disabled={!state.fresh} onPress={()=>void open(item.interaction.interactionId)}/></View>)}
  {state.view?.deliveryPending?<Text style={styles.text}>Scheduled task results are still arriving or unavailable. Check execution history in Schedules.</Text>:null}
  {state.view?.hasMore?<Text style={styles.text}>More scheduled task items are available in Schedules.</Text>:null}
  {state.error?<><Text accessibilityRole="alert" style={styles.text}>{state.error}</Text><Button label="Refresh scheduled tasks" onPress={state.refresh}/></>:null}<Button label="Persistent task" variant="outline" onPress={()=>void open()}/>{message?<Text style={styles.text}>{message}</Text>:null}
 </View>;
}
const styles=StyleSheet.create(theme=>({panel:{gap:8,padding:12},text:{color:theme.colors.foreground}}));
