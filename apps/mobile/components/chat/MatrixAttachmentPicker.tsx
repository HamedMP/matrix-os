import { useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { FileResourceRefSchema } from "@matrix-os/contracts";

import { BackIcon, IconButton, SheetGrabber } from "@/components/ui";
import type { ChatAttachmentKind, ComposerAttachment } from "@/lib/chat-attachments";
import { discardMatrixAttachment, stageMatrixAttachment } from "@/lib/matrix-attachment";
import { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { useComputerDirectory } from "@/lib/queries/use-computer-directory";

export interface MatrixAttachmentBinding {
  scope: string;
  gatewayUrl: string;
}

export function MatrixAttachmentPicker({ binding, kinds, room, attachments, onBack, onAdd }: {
  binding: MatrixAttachmentBinding;
  kinds: readonly ChatAttachmentKind[];
  room: number;
  attachments: readonly ComposerAttachment[];
  onBack: () => void;
  onAdd: (attachment: ComposerAttachment) => void;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [path, setPath] = useState("");
  const { entries, isPending, isError, refresh, computer } = useComputerDirectory(path);
  const gateway = useActiveGateway();
  const request = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kindsKey = kinds.join(",");
  const ready = gateway.ready && gateway.gatewayUrl === binding.gatewayUrl
    && computer?.gatewayPath === gateway.computer?.gatewayPath;
  useLayoutEffect(() => () => { request.current?.abort(); }, [
    binding.scope, binding.gatewayUrl, gateway.userId, ready, room, kindsKey,
  ]);

  async function select(fullPath: string) {
    if (!ready || room <= 0 || request.current) return;
    if (attachments.some(({ matrixSource: source }) => (
      source?.path === fullPath && source.gatewayUrl === binding.gatewayUrl && source.userId === gateway.userId
    ))) {
      setError("This Matrix file is already attached.");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    try {
      const session = await gateway.session();
      if (controller.signal.aborted) return;
      if (!session || session.gatewayUrl !== binding.gatewayUrl) throw new Error("MatrixAttachmentUnavailable");
      const attachment = await stageMatrixAttachment({
        gatewayUrl: binding.gatewayUrl, userId: gateway.userId, path: fullPath,
      }, session.token, kinds, controller.signal);
      if (controller.signal.aborted) discardMatrixAttachment(attachment);
      else onAdd(attachment);
    } catch (cause: unknown) {
      if (!controller.signal.aborted) {
        const code = cause instanceof Error ? cause.message : "";
        setError(code === "MatrixAttachmentTooLarge" ? "This Matrix file exceeds the attachment size limit."
          : code === "MatrixAttachmentUnsupported" ? "The selected model cannot read this file."
            : "Could not read this Matrix file. Try again.");
      }
    } finally {
      request.current = null;
      setPending(false);
    }
  }

  return <View style={[styles.container, { paddingBottom: insets.bottom + theme.v2.space[10] }]}>
    <SheetGrabber />
    <View style={styles.header}>
      <IconButton accessibilityLabel="Back" icon={BackIcon} iconSize={22} buttonSize={theme.v2.size.control}
        onPress={() => {
          if (!path) { request.current?.abort(); onBack(); }
          else if (!pending) { setError(null); setPath(path.split("/").slice(0, -1).join("/")); }
        }} />
      <Text accessibilityRole="header" style={styles.title}>Matrix Files</Text>
    </View>
    <Text numberOfLines={1} style={styles.text}>{path || "Matrix home"}</Text>
    {error ? <Text accessibilityRole="alert" style={styles.text}>{error}</Text> : null}
    {isPending || pending ? <ActivityIndicator accessibilityLabel={pending ? "Reading file" : "Loading files"} /> : null}
    {!isPending && (isError || !ready) ? <Pressable accessibilityRole="button" onPress={() => { void refresh(); }} style={styles.row}>
      <Text style={styles.text}>Files unavailable. Retry</Text>
    </Pressable> : null}
    {ready && !isError && !isPending ? <FlatList
      style={styles.list}
      data={entries}
      keyExtractor={entry => entry.name}
      ListEmptyComponent={<Text style={styles.text}>This folder is empty.</Text>}
      renderItem={({ item }) => <Pressable accessibilityRole="button"
        accessibilityLabel={`${item.type === "directory" ? "Open" : "Attach"} ${item.name}`}
        disabled={pending || room <= 0} style={styles.row}
        onPress={() => {
          const next = path ? `${path}/${item.name}` : item.name;
          if (!FileResourceRefSchema.safeParse({ kind: "home", path: next }).success) return;
          if (item.type === "directory") { setError(null); setPath(next); }
          else void select(next);
        }}>
        <Text numberOfLines={1} style={styles.text}>{item.name}{item.type === "directory" ? "/" : ""}</Text>
      </Pressable>}
    /> : null}
  </View>;
}

const styles = StyleSheet.create(theme => ({
  container: { paddingHorizontal: theme.v2.space[20], gap: theme.v2.space[10] },
  header: { flexDirection: "row", alignItems: "center", gap: theme.v2.space[4] },
  title: { ...theme.v2.text.headline, color: theme.v2.colors.textDefault },
  text: { ...theme.v2.text.body, color: theme.v2.colors.textDefault },
  list: { maxHeight: 320, flexGrow: 0 },
  row: { minHeight: theme.v2.size.tapTarget, justifyContent: "center", paddingHorizontal: theme.v2.space[8] },
}));
