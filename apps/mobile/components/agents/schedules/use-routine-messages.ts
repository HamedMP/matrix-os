import {useEffect,useMemo,useState} from "react";
import {AppState} from "react-native";
import {useIsFocused} from "expo-router";
import {useRoutineMessages} from "@matrix-os/ui/bot-routine-messages";
import {useActiveGateway} from "@/lib/queries/use-active-gateway";
import {createNativeRoutineClient} from "@/lib/requests/routines";

export function useNativeRoutineMessages(chatId:string|null,enabled:boolean){
  const gateway=useActiveGateway();
  const focused=useIsFocused();
  const [active,setActive]=useState(AppState.currentState==="active");
  useEffect(()=>{const subscription=AppState.addEventListener("change",state=>setActive(state==="active"));return()=>subscription.remove();},[]);
  const api=useMemo(()=>createNativeRoutineClient(gateway.session),[gateway.session,gateway.userId,gateway.computerKey]);
  return useRoutineMessages(api,chatId??undefined,enabled&&gateway.ready&&focused&&active);
}
