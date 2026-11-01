import { useMemo } from "react";
import { Text } from "react-native";
import { useRouter } from "expo-router";
import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { createNativeRoutineClient } from "@/lib/requests/routines";
import { resolveNativeBotInteraction } from "@/lib/requests/bots";
import { SchedulesScreen } from "@/components/agents/schedules/SchedulesScreen";
import { TabScreen } from "@/components/shell/TabScreen";
import { Button } from "@/components/ui";

export default function SchedulesRoute() {
  const gateway = useActiveGateway(), router = useRouter();
  const api = useMemo(() => createNativeRoutineClient(gateway.session), [gateway.session]);
  const scope = `${gateway.userId}:${gateway.computerKey}`;
  if (!gateway.ready) return <TabScreen><Text>{gateway.isComputerPending ? "Loading Computer…" : "Schedules unavailable. Select a Computer and try again."}</Text><Button label="Back" onPress={() => router.back()} /></TabScreen>;
  return <SchedulesScreen key={scope} api={api} onBack={() => router.back()}
    resolve={async (interaction, input) => {
      const auth = await gateway.session();
      if (!auth) throw new Error("Schedule response could not be saved.");
      return resolveNativeBotInteraction(auth.token, auth.gatewayUrl, interaction.chatId, interaction.interactionId, input);
    }} />;
}
