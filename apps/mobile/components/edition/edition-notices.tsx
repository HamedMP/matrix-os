import { Text, View } from "react-native";
import type { useEdition } from "../../../../home/app-templates/connected-starter/src/edition/useEdition";
import { EditionButton } from "./edition-ui";
import { styles } from "./edition-styles";
export function EditionNotices({
  data,
  retry,
}: {
  data: ReturnType<typeof useEdition>;
  retry(): void;
}) {
  return (
    <>
      {data.offline && (
        <View style={styles.notice}>
          <Text selectable style={styles.body}>
            Offline · your downloaded editions are available.
          </Text>
          <EditionButton label="Retry Edition connection" onPress={retry} />
        </View>
      )}
      {data.error && (
        <View style={styles.notice}>
          <Text selectable accessibilityRole="alert" style={styles.body}>
            {data.error}
          </Text>
          {!data.offline && (
            <EditionButton label="Retry Edition connection" onPress={retry} />
          )}
        </View>
      )}
      {(data.status || data.receipt) && (
        <View style={styles.notice}>
          <Text selectable style={styles.body}>
            {data.status || "Previous inbox cleanup is available to review."}
          </Text>
          {data.operations.length > 1 && (
            <View style={styles.row}>
              {data.operations.map((op, i) => (
                <EditionButton
                  key={op.receipt.id}
                  label={`Cleanup ${i + 1} · ${op.receipt.state.replaceAll("_", " ")}`}
                  onPress={() => data.selectCleanup(op.receipt.id)}
                />
              ))}
            </View>
          )}
          {data.receipt?.state === "needs_verification" && (
            <EditionButton
              label="Verify archive outcome"
              disabled={data.offline || data.busy}
              onPress={() => void data.cleanupCommit()}
            />
          )}
          {data.receipt &&
            data.receipt.state !== "undone" &&
            (data.receipt.archivedCount ?? 0) > 0 && (
              <EditionButton
                label="Undo inbox archive"
                disabled={data.offline || data.busy}
                onPress={() => void data.undo()}
              />
            )}
        </View>
      )}
    </>
  );
}
