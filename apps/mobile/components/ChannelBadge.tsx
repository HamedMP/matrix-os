import { View, Text } from "react-native";

interface ChannelBadgeProps {
  name: string;
  status: "connected" | "degraded" | "error" | "not_configured";
}

const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
  connected: { dot: "bg-success", label: "Connected" },
  degraded: { dot: "bg-warning", label: "Degraded" },
  error: { dot: "bg-destructive", label: "Error" },
  not_configured: { dot: "bg-muted-foreground", label: "Not configured" },
};

export function ChannelBadge({ name, status }: ChannelBadgeProps) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.not_configured;

  return (
    <View className="flex-row items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
      <Text className="text-sm font-medium capitalize text-foreground" style={{ fontFamily: "Inter_500Medium" }}>
        {name}
      </Text>
      <View className="flex-row items-center gap-2">
        <View className={`size-2 rounded-full ${style.dot}`} />
        <Text className="text-xs text-muted-foreground">{style.label}</Text>
      </View>
    </View>
  );
}
