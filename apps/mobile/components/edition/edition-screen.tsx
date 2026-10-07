import React, { useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { filterEditions } from "../../../../home/app-templates/connected-starter/src/edition/model";
import { useEdition } from "../../../../home/app-templates/connected-starter/src/edition/useEdition";
import type { EditionRuntime } from "../../../../home/app-templates/connected-starter/src/edition/runtime";
import type {
  EditionScope,
  EditionView,
} from "../../../../home/app-templates/connected-starter/src/edition/types";
import { useNativeEditionRuntime } from "@/lib/edition/use-edition-runtime";
import { EditionReader } from "./edition-reader";
import { EditionSetup } from "./edition-setup";
import { EditionButton } from "./edition-ui";
import { palette, styles } from "./edition-styles";
import { EditionNotices } from "./edition-notices";
import { EditionLibrary } from "./edition-library";
export default function NativeEditionScreen() {
  const host = useNativeEditionRuntime();
  const computer = host.computer;
  const [setup, setSetup] = useState(false);
  if (!host.runtime || !computer)
    return (
      <View style={[styles.screen, { padding: 24, justifyContent: "center" }]}>
        {host.isPending ? (
          <ActivityIndicator color={palette.plum} />
        ) : (
          <Text selectable style={styles.body}>
            {host.isError
              ? "Your Matrix computer is unavailable. Try again."
              : "Sign in and select your Matrix computer to open Edition."}
          </Text>
        )}
      </View>
    );
  return (
    <EditionRoom
      key={host.identity}
      runtime={host.runtime}
      onSetup={() => setSetup(true)}
      setup={
        setup
          ? (reload, sources) => (
              <EditionSetup
                computer={computer}
                getToken={host.getToken}
                bridge={host.runtime!.bridge!}
                onConnected={reload}
                existingSources={sources}
                onClose={() => setSetup(false)}
              />
            )
          : undefined
      }
    />
  );
}
export function EditionRoom({
  runtime,
  onSetup,
  setup,
}: {
  runtime: EditionRuntime & { retry?(): void };
  onSetup?(): void;
  setup?: (
    reload: () => Promise<void>,
    sources: ReturnType<typeof useEdition>["sources"],
  ) => React.ReactNode;
}) {
  const [view, setView] = useState<EditionView>("library"),
    [scope, setScope] = useState<EditionScope>("all"),
    [query, setQuery] = useState(""),
    [sourceId, setSourceId] = useState(""),
    [selected, setSelected] = useState<string[]>([]);
  const insets = useSafeAreaInsets();
  const data = useEdition({ view, scope, query, sourceId }, runtime);
  const messages = filterEditions(data.messages, data.sources, {
    view,
    scope,
    query,
    sourceId,
  });
  function approveCleanup() {
    const plan = data.approval;
    if (!plan) return;
    const exact = plan.messageIds
      .map((id) => {
        const m = data.messages.find((m) => m.id === id);
        return `${m?.subject ?? "Saved newsletter"} · ${data.sources.find((s) => s.id === m?.sourceId)?.email ?? "Exact selected account"}`;
      })
      .join("\n");
    Alert.alert(
      "Review inbox cleanup",
      `${exact}\n\nThese exact newsletters leave your inbox. Retained editions and source read labels stay unchanged.`,
      [
        { text: "Keep in inbox", style: "cancel", onPress: data.cancelCleanup },
        { text: "Archive selected", onPress: () => void data.cleanupCommit() },
      ],
    );
  }
  return (
    <View style={styles.screen}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(48, insets.bottom + 24) },
        ]}
      >
        <View style={styles.row}>
          <Text style={[styles.eyebrow, { flex: 1 }]}>
            EDITION · YOUR PRIVATE READING ROOM
          </Text>
          <EditionButton
            label="Add email account"
            disabled={data.offline || !onSetup}
            onPress={() => onSetup?.()}
          />
        </View>
        <Text style={styles.title}>
          A little less inbox.\nA little more reading.
        </Text>
        <EditionNotices
          data={data}
          retry={() => {
            runtime.retry?.();
            void data.reload();
          }}
        />
        {data.loading && <ActivityIndicator color={palette.plum} />}
        {data.active ? (
          <EditionReader key={data.active.id} data={data} />
        ) : (
          <EditionLibrary
            data={data}
            messages={messages}
            view={view}
            scope={scope}
            query={query}
            sourceId={sourceId}
            selected={selected}
            setView={setView}
            setScope={setScope}
            setQuery={setQuery}
            setSourceId={setSourceId}
            setSelected={setSelected}
            approveCleanup={approveCleanup}
          />
        )}
      </ScrollView>
      {setup?.(data.reload, data.sources)}
    </View>
  );
}
