import { Redirect } from "expo-router";
import { useGateway } from "./_layout";

export default function Index() {
  const { gateway } = useGateway();

  if (!gateway) {
    return <Redirect href="/connect" />;
  }

  return <Redirect href="/(tabs)/chat" />;
}
