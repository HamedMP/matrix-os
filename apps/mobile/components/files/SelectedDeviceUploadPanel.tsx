import { createElement, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAuth } from "@clerk/clerk-expo";
import { useQueryClient } from "@tanstack/react-query";
import { createSelectedFileUploadController } from "@matrix-os/contracts/file-upload";
import type { MatrixComputer } from "@matrix-os/contracts";
import { Spacer } from "@/components/ui";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { mobileQueryKeys } from "@/lib/requests/query-keys";
import { AnalyticsMask } from "@/lib/analytics";
import {
  cleanupSelectedDeviceFile,
  pickSelectedDeviceFiles,
  uploadSelectedDeviceFile,
  type SelectedDeviceFile,
} from "@/lib/selected-device-files";

type Target = Pick<MatrixComputer, "handle" | "runtimeSlot" | "gatewayPath">;
export function SelectedDeviceUploadPanel({ currentPath, computer }: { currentPath: string; computer: Target }) {
  const { userId } = useAuth();
  return <UploadSession key={`${userId}:${computer.handle}:${computer.runtimeSlot}:${computer.gatewayPath}`} currentPath={currentPath} computer={computer} />;
}

function UploadSession({ currentPath, computer }: { currentPath: string; computer: Target }) {
  const { getToken, userId } = useAuth();
  const queryClient = useQueryClient();
  const mounted = useRef(true);
  const picking = useRef(false);
  const [isPicking, setIsPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const computerKey = `${computer.handle}:${computer.runtimeSlot}`;
  const [controller] = useState(() => createSelectedFileUploadController<SelectedDeviceFile>({
    getScope: () => `${userId}:${computerKey}`,
    upload: async (file, path, signal) => {
      const token = await getToken();
      if (!token || signal.aborted) throw new Error("Upload unavailable");
      await uploadSelectedDeviceFile(token, `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`, file, path, signal);
    },
    release: cleanupSelectedDeviceFile,
    onUploaded: directory => { void queryClient.invalidateQueries({ queryKey: mobileQueryKeys.files(userId ?? "signed-out", computerKey, directory) }); },
  }));
  const rows = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.clear(); };
  }, [controller]);

  async function choose(kind: "files" | "photos") {
    if (picking.current) return;
    picking.current = true;
    setIsPicking(true);
    setPickError(null);
    try {
      const assets = await pickSelectedDeviceFiles(kind);
      if (!mounted.current) { assets.forEach(cleanupSelectedDeviceFile); return; }
      controller.enqueue(assets, currentPath);
    } catch (error: unknown) {
      console.warn("[selected-upload] picker unavailable", error instanceof Error ? error.name : "UnknownError");
      if (mounted.current) setPickError("Could not select files. Try again.");
    } finally {
      picking.current = false;
      if (mounted.current) setIsPicking(false);
    }
  }

  return createElement(AnalyticsMask, null, <View style={styles.panel}>
    <Text style={styles.title}>Upload to {computer.handle}</Text>
    <Spacer size="sm" />
    <Text style={styles.detail}>{currentPath || "My files"} · up to 10 MB per file</Text>
    <Spacer size="sm" />
    <Text style={styles.detail}>Choose only the photos, documents or exports you want to send.</Text>
    <Spacer size="lg" />
    <View style={styles.actions}>
      <Action label="Choose files" disabled={isPicking} onPress={() => void choose("files")} />
      <Action label="Choose photos" disabled={isPicking} onPress={() => void choose("photos")} />
      {isPicking ? <ActivityIndicator accessibilityLabel="Selecting files" /> : null}
    </View>
    {pickError ? <Text style={styles.error}>{pickError}</Text> : null}
    <Spacer size="lg" />
    {rows.map(row => <View key={row.id} style={styles.row}>
      <Text style={styles.name}>{row.name}</Text>
      <Text style={styles.detail}>{row.status === "uploading" ? "Uploading…" : row.status === "queued" ? "Waiting…" : row.error}</Text>
      <View style={styles.actions}>
        {row.status === "uploading" || row.status === "queued"
          ? <Action label={`Cancel ${row.name}`} text="Cancel" onPress={() => controller.cancel(row.id)} />
          : <Action label={`Retry ${row.name}`} text="Retry" onPress={() => controller.retry(row.id)} />}
        <Action label={`Remove ${row.name}`} text="Remove" onPress={() => controller.remove(row.id)} />
      </View>
      <Spacer size="md" />
    </View>)}
  </View>);
}

function Action({ label, text = label, onPress, disabled }: { label: string; text?: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
    accessibilityState={{ disabled: Boolean(disabled) }} onPress={onPress} style={({ pressed }) => [styles.action, (pressed || disabled) && styles.dim]}>
    <Text style={styles.actionText}>{text}</Text>
  </Pressable>;
}

const styles = StyleSheet.create(theme => ({
  panel: { paddingHorizontal: 16 },
  title: { fontFamily: theme.v2.fonts.semibold, fontSize: 18, color: theme.v2.appColors.ink },
  detail: { fontFamily: theme.v2.fonts.body, fontSize: 13, color: theme.v2.appColors.muted },
  name: { fontFamily: theme.v2.fonts.medium, fontSize: 14, color: theme.v2.appColors.ink },
  error: { fontFamily: theme.v2.fonts.body, fontSize: 13, color: theme.v2.palette.coral[600] },
  row: { alignSelf: "stretch" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  action: { minHeight: 44, borderWidth: 1, borderColor: theme.v2.palette.neutral[300], borderRadius: 12, paddingHorizontal: 12, justifyContent: "center" },
  actionText: { fontFamily: theme.v2.fonts.medium, fontSize: 14, color: theme.v2.appColors.ink },
  dim: { opacity: 0.5 },
}));
