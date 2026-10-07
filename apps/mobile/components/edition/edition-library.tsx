import React, { type Dispatch, type SetStateAction } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import {
  editionDate,
  publicationTone,
} from "../../../../home/app-templates/connected-starter/src/edition/model";
import { sourceStatus } from "../../../../home/app-templates/connected-starter/src/edition/source-status";
import type { useEdition } from "../../../../home/app-templates/connected-starter/src/edition/useEdition";
import type {
  EditionMessage,
  EditionView,
  EditionScope,
} from "../../../../home/app-templates/connected-starter/src/edition/types";
import { EditionButton } from "./edition-ui";
import { styles } from "./edition-styles";
const covers = ["#E8DFE9", "#E3E9E2", "#ECE2D3", "#E0E7EB", "#F0DDDA"];
interface Props {
  data: ReturnType<typeof useEdition>;
  messages: EditionMessage[];
  view: EditionView;
  scope: EditionScope;
  query: string;
  sourceId: string;
  selected: string[];
  setView(next: EditionView): void;
  setScope(next: EditionScope): void;
  setQuery(next: string): void;
  setSourceId(next: string): void;
  setSelected: Dispatch<SetStateAction<string[]>>;
  approveCleanup(): void;
}
export function EditionLibrary({
  data,
  messages,
  view,
  scope,
  query,
  sourceId,
  selected,
  setView,
  setScope,
  setQuery,
  setSourceId,
  setSelected,
  approveCleanup,
}: Props) {
  const selectedIds = new Set(selected);
  const visibleIds = new Set(messages.map((m) => m.id));
  const selectedVisible = selected.filter((id) => visibleIds.has(id));
  return (
    <>
      <View style={styles.row}>
        {(["library", "latest", "unread", "saved", "review"] as const).map(
          (item) => (
            <EditionButton
              key={item}
              label={item[0].toUpperCase() + item.slice(1)}
              primary={view === item}
              onPress={() => {
                setView(item);
                setSelected([]);
              }}
            />
          ),
        )}
      </View>
      <TextInput
        accessibilityLabel="Search editions"
        placeholder="Search your reading room"
        maxLength={200}
        value={query}
        onChangeText={setQuery}
        style={styles.input}
      />
      <View style={styles.row}>
        {(["all", "personal", "work"] as const).map((item) => (
          <EditionButton
            key={item}
            label={
              item === "all"
                ? "All accounts"
                : item === "work"
                  ? "Work"
                  : "Personal"
            }
            primary={scope === item}
            onPress={() => {
              setScope(item);
              setSelected([]);
            }}
          />
        ))}
      </View>
      <View style={styles.row}>
        <EditionButton
          label="Every email source"
          primary={!sourceId}
          onPress={() => {
            setSourceId("");
            setSelected([]);
          }}
        />
        {data.sources.map((source) => (
          <EditionButton
            key={source.id}
            label={`${source.email} · ${source.scope === "work" ? "Work" : "Personal"}`}
            primary={sourceId === source.id}
            onPress={() => {
              setSourceId(source.id);
              setSelected([]);
            }}
          />
        ))}
      </View>
      {data.sources.some(
        (s) => s.state === "pending" || s.state === "running",
      ) && (
        <Text selectable style={styles.muted}>
          Your selected history is being imported. New editions will appear as
          they arrive.
        </Text>
      )}
      {!data.loading && !messages.length && (
        <View style={styles.cover}>
          <Text style={styles.heading}>
            {data.sources.length
              ? "A quiet shelf."
              : "Make room for good ideas."}
          </Text>
          <Text style={styles.body}>
            {data.sources.length
              ? "No editions match this view yet."
              : "Choose an exact connected email account to import your selected newsletter history."}
          </Text>
        </View>
      )}
      {messages.map((message) => (
        <View key={message.id} style={styles.card}>
          <View
            style={[
              styles.cover,
              {
                backgroundColor: covers[publicationTone(message.publication)],
              },
            ]}
          >
            <Text style={styles.eyebrow}>
              {message.publication.toUpperCase()}
            </Text>
            <Text selectable style={styles.heading}>
              {message.subject}
            </Text>
            <Text style={styles.muted}>
              {editionDate(message.receivedAt)} ·{" "}
              {message.read ? "Read" : "Unread"}
              {message.saved ? " · Saved" : ""}
            </Text>
          </View>
          <Text style={styles.body}>{message.excerpt}</Text>
          <Text selectable style={styles.muted}>
            {data.sources.find((s) => s.id === message.sourceId)?.email}
          </Text>
          <View style={styles.row}>
            <EditionButton
              label={`Read ${message.subject}`}
              primary
              disabled={data.busy}
              onPress={() => void data.open(message.id)}
            />
            {message.classification === "newsletter" && (
              <EditionButton
                label={`${selectedIds.has(message.id) ? "Deselect" : "Select"} for inbox cleanup`}
                disabled={data.offline || data.busy}
                onPress={() => {
                  if (!sourceId) {
                    setSourceId(message.sourceId);
                    setSelected([message.id]);
                  } else
                    setSelected((ids) =>
                      new Set(ids).has(message.id)
                        ? ids.filter((id) => id !== message.id)
                        : [...ids, message.id].slice(0, 100),
                    );
                }}
              />
            )}
          </View>
        </View>
      ))}
      {selectedVisible.length > 0 && (
        <EditionButton
          label={`Review inbox cleanup (${selectedVisible.length})`}
          disabled={data.offline || data.busy}
          onPress={() => void data.cleanupPreview(selectedVisible)}
        />
      )}
      {data.approval && (
        <View style={styles.notice}>
          <Text style={styles.heading}>Review exact inbox selection</Text>
          {data.approval.messageIds.map((id) => (
            <Text key={id} selectable style={styles.body}>
              {data.messages.find((m) => m.id === id)?.subject ??
                "Saved newsletter"}
            </Text>
          ))}
          <EditionButton
            label="Confirm inbox cleanup"
            primary
            onPress={approveCleanup}
          />
          <EditionButton label="Keep in inbox" onPress={data.cancelCleanup} />
        </View>
      )}
      {data.cursor && (
        <EditionButton
          label="Load more editions"
          disabled={data.busy || data.offline}
          onPress={() => void data.loadMore()}
        />
      )}
      <Text style={styles.heading}>Sources & retention</Text>
      {data.sources.map((source) => (
        <View key={source.id} style={styles.notice}>
          <Text selectable style={styles.body}>
            {source.email} · {source.scope === "work" ? "Work" : "Personal"}
          </Text>
          {sourceStatus(source).map((line) => (
            <Text key={line} selectable style={styles.muted}>
              {line}
            </Text>
          ))}
          <EditionButton
            label={`Sync ${source.email}`}
            disabled={data.busy || data.offline || source.state === "paused"}
            onPress={() => void data.sync(source.id)}
          />
          <EditionButton
            label="Stop importing"
            disabled={data.busy || data.offline || source.state === "paused"}
            onPress={() =>
              Alert.alert(
                "Stop importing this account?",
                `${source.email}\nRetained editions, reading state and authorized sharing remain available. Add this exact account again to resume. Source email stays unchanged.`,
                [
                  { text: "Keep account", style: "cancel" },
                  {
                    text: "Stop importing account",
                    onPress: () => void data.retention(source.id, "keep"),
                  },
                ],
              )
            }
          />
          <EditionButton
            label="Remove retained account history"
            disabled={data.busy || data.offline}
            onPress={() =>
              Alert.alert(
                "Remove retained account history?",
                `${source.email}\nRetained history and reading state will be removed from Matrix and this device. Sharing grants are revoked. This cannot be undone. Source email stays unchanged.`,
                [
                  { text: "Keep account", style: "cancel" },
                  {
                    text: "Remove retained history",
                    style: "destructive",
                    onPress: () => void data.retention(source.id, "purge"),
                  },
                ],
              )
            }
          />
        </View>
      ))}
      <Text style={styles.muted}>
        Device downloads are limited to 50 editions and 5 MB. Reading updates
        wait safely on this device; inbox cleanup always requires a connection.
      </Text>
      <EditionButton
        label="Sync now"
        disabled={data.busy || data.offline || !data.sources.length}
        onPress={() => void data.sync(sourceId || data.sources[0].id)}
      />
    </>
  );
}
