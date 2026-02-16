import { View, Text, Pressable, Alert } from "react-native";
import type { GatewayConnection } from "@/lib/storage";

interface GatewayCardProps {
  gateway: GatewayConnection;
  onSelect: () => void;
  onRemove: () => void;
}

export function GatewayCard({ gateway, onSelect, onRemove }: GatewayCardProps) {
  const handleLongPress = () => {
    Alert.alert("Remove Gateway", `Remove "${gateway.name}"?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: onRemove },
    ]);
  };

  return (
    <Pressable
      onPress={onSelect}
      onLongPress={handleLongPress}
      className="mb-2 rounded-xl border border-border bg-card px-4 py-3 shadow-sm active:opacity-70"
    >
      <Text className="text-base font-medium text-foreground" style={{ fontFamily: "Inter_600SemiBold" }}>
        {gateway.name}
      </Text>
      <Text className="mt-1 font-mono text-xs text-muted-foreground">
        {gateway.url}
      </Text>
      {gateway.token && (
        <View className="mt-1.5 flex-row">
          <View className="rounded-full bg-primary/10 px-2 py-0.5">
            <Text className="text-xs text-primary">Authenticated</Text>
          </View>
        </View>
      )}
    </Pressable>
  );
}
