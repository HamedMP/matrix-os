import React, { useState } from "react";
import { Alert, Text, View } from "react-native";
import { readingMinutes } from "../../../../home/app-templates/connected-starter/src/edition/model";
import type { useEdition } from "../../../../home/app-templates/connected-starter/src/edition/useEdition";
import { EditionButton } from "./edition-ui";
import { styles } from "./edition-styles";
export function EditionReader({
  data,
}: {
  data: ReturnType<typeof useEdition>;
}) {
  const [fontSize, setFontSize] = useState(19);
  const message = data.active!;
  const source = data.sources.find((s) => s.id === message.sourceId);
  const downloaded = data.downloaded.includes(message.id);
  const disabled = data.busy;
  return (
    <View style={{ gap: 20 }}>
      <EditionButton label="Back to library" onPress={data.close} />
      <Text style={styles.eyebrow}>{message.publication.toUpperCase()}</Text>
      <Text selectable style={styles.title}>
        {message.subject}
      </Text>
      <Text selectable style={styles.muted}>
        {source?.email} · {source?.scope === "work" ? "Work" : "Personal"} ·{" "}
        {readingMinutes(message.text ?? message.excerpt)} min read
      </Text>
      <View style={styles.row}>
        <EditionButton
          label={message.saved ? "Unsave edition" : "Save edition"}
          disabled={disabled}
          onPress={() => void data.reading({ saved: !message.saved })}
        />
        <EditionButton
          label={message.read ? "Mark unread" : "Mark as read"}
          disabled={disabled}
          onPress={() =>
            void data.reading({
              read: !message.read,
              progress: message.read ? 0 : 1,
            })
          }
        />
        <EditionButton
          label={downloaded ? "Remove device download" : "Download edition"}
          disabled={
            disabled ||
            (!downloaded && (!data.canDownload || !!message.partial))
          }
          onPress={() =>
            void (downloaded ? data.removeDownload() : data.download())
          }
        />
        <EditionButton
          label="Smaller text"
          disabled={fontSize <= 16}
          onPress={() => setFontSize((size) => Math.max(16, size - 1))}
        />
        <EditionButton
          label="Larger text"
          disabled={fontSize >= 28}
          onPress={() => setFontSize((size) => Math.min(28, size + 1))}
        />
      </View>
      <View style={styles.separator} />
      <Text
        selectable
        style={[styles.article, { fontSize, lineHeight: fontSize * 1.65 }]}
      >
        {message.text ?? message.excerpt}
      </Text>
      <View style={styles.notice}>
        <Text style={styles.muted}>
          Reading progress · {Math.round(message.progress * 100)}%
        </Text>
        <View style={styles.row}>
          {[0.25, 0.5, 0.75, 1].map((progress) => (
            <EditionButton
              key={progress}
              label={`Read ${Math.round(progress * 100)}%`}
              disabled={disabled}
              onPress={() => void data.reading({ progress })}
            />
          ))}
        </View>
      </View>
      <Text style={styles.muted}>
        Email content is shown as safe text. Remote images and tracking pixels
        stay off.
      </Text>
      <View style={styles.row}>
        <EditionButton
          label="This is a newsletter"
          disabled={disabled || data.offline}
          onPress={() => void data.correct("newsletter")}
        />
        <EditionButton
          label="Not a newsletter"
          disabled={disabled || data.offline}
          onPress={() => void data.correct("other")}
        />
        <EditionButton
          label="Export edition"
          disabled={disabled || data.offline}
          onPress={() => void data.exportEdition()}
        />
        <EditionButton
          label="Remove retained email"
          disabled={disabled || data.offline}
          onPress={() =>
            Alert.alert(
              "Remove retained email?",
              "The retained copy and device download will be removed. Your source email stays unchanged.",
              [
                { text: "Keep", style: "cancel" },
                {
                  text: "Remove",
                  style: "destructive",
                  onPress: () => void data.deleteEdition(),
                },
              ],
            )
          }
        />
      </View>
    </View>
  );
}
