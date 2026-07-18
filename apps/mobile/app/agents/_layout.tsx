import { Stack } from "expo-router/stack";

export default function AgentsLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: "Agents" }} />
      <Stack.Screen name="new" options={{ title: "New Run" }} />
      <Stack.Screen name="[threadId]" options={{ title: "Agent Thread" }} />
      <Stack.Screen
        name="projects/[projectId]/index"
        options={{ title: "Project Conversations" }}
      />
    </Stack>
  );
}
