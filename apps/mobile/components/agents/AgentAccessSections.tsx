import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  MATRIX_BOT_SELECTION,
  botModelRoutingLabel,
  botTaskStatusCopy,
  managedPiBotModelChoices,
  type BotAuthorityView,
  type BotMemoryMutationRequest,
  type BotTaskSummary,
  type CanonicalChatModelSelection,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";

import { Button } from "@/components/ui";
import { blockedNativeBotModelRows } from "@/lib/bot-model-discovery";
import { formatRelativeTime } from "@/lib/relative-time";

import { serviceLabel } from "./agent-copy";
import { DetailsSection } from "./DetailsSection";

const ACCESS_FAILED = "Could not change the agent's access. Try again.";
const MODEL_FAILED = "Model could not be saved. Try again.";
const STATUS_FAILED = "Agent status could not be loaded. Try again.";
const AUTOMATIC_MODEL = "Automatic · managed by this computer";

type Section = "permissions" | "memory" | "model";

export interface AgentAccessSectionsProps {
  /** What the agent may use and what it remembers. Null when that could not be read. */
  authority: BotAuthorityView | null;
  /** The agent's unfinished tasks. */
  tasks: readonly BotTaskSummary[];
  /** The agent's saved model. The Model section is drawn once it is known. */
  selection?: CanonicalChatModelSelection;
  catalog?: CanonicalProviderCatalog | null;
  /** False while the agent's status could not be read again, so what is shown may be out of date. */
  actionsAvailable: boolean;
  onRevoke: (grantId: string) => Promise<unknown>;
  onMemory: (itemId: string, action: "confirm" | "forget", input: BotMemoryMutationRequest) => Promise<unknown>;
  /** Saves another model for the agent. Without it the model is shown and cannot be changed. */
  onSelectModel?: (selection: CanonicalChatModelSelection) => Promise<unknown>;
  /** Reads the agent's status again once the server has a change. */
  onRefresh: () => Promise<unknown> | void;
}

function sentence(words: readonly string[]): string {
  const joined = words.join(", ");
  return joined ? `${joined[0].toUpperCase()}${joined.slice(1)}` : joined;
}

/** What the details sheet keeps beyond the design's own sections: tasks, permissions, memory and model. */
export function AgentAccessSections({
  authority,
  tasks,
  selection,
  catalog,
  actionsAvailable,
  onRevoke,
  onMemory,
  onSelectModel,
  onRefresh,
}: AgentAccessSectionsProps) {
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ section: Section; message: string } | null>(null);
  const inFlight = useRef(false);

  // One change at a time. What is listed moves only when the status is read again.
  const change = async (section: Section, id: string, action: () => Promise<unknown>) => {
    if (inFlight.current || !actionsAvailable) return;
    inFlight.current = true;
    setPending(`${section}:${id}`);
    setFailure(null);
    try {
      await action();
      try {
        await onRefresh();
      } catch (error: unknown) {
        console.warn("[mobile] agent status refresh failed", error instanceof Error ? error.name : "unknown");
        setFailure({ section, message: STATUS_FAILED });
      }
    } catch (error: unknown) {
      console.warn("[mobile] agent access change failed", error instanceof Error ? error.name : "unknown");
      setFailure({ section, message: section === "model" ? MODEL_FAILED : ACCESS_FAILED });
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  const control = (section: Section, id: string) => ({
    loading: pending === `${section}:${id}`,
    disabled: !actionsAvailable || (pending !== null && pending !== `${section}:${id}`),
  });
  const errorIn = (section: Section) => (failure?.section === section ? failure.message : null);

  const grants = authority?.grants ?? [];
  const memories = authority?.memory.items ?? [];

  return (
    <>
      {tasks.length > 0 ? (
        <DetailsSection testID="agent-details-tasks" label="Tasks">
          {tasks.map((task) => (
            <Text key={task.taskId} style={[styles.row, styles.primary]}>{botTaskStatusCopy(task)}</Text>
          ))}
        </DetailsSection>
      ) : null}
      {grants.length > 0 ? (
        <DetailsSection testID="agent-details-permissions" label="Permissions" error={errorIn("permissions")}>
          {grants.map((grant) => (
            <View key={grant.grantId} style={[styles.row, styles.split]}>
              <View style={styles.text}>
                <Text style={styles.primary}>{`${serviceLabel(grant.service)} · ${grant.accountLabel}`}</Text>
                <Text style={styles.secondary}>{sentence(grant.effects)}</Text>
              </View>
              <Button
                variant="outline"
                label="Revoke"
                accessibilityLabel={`Revoke ${grant.accountLabel}`}
                {...control("permissions", grant.grantId)}
                onPress={() => void change("permissions", grant.grantId, () => onRevoke(grant.grantId))}
              />
            </View>
          ))}
        </DetailsSection>
      ) : null}
      {memories.length > 0 ? (
        <DetailsSection testID="agent-details-memory" label="Memory" error={errorIn("memory")}>
          {memories.map((item) => (
            <View key={item.itemId} style={[styles.row, styles.stack]}>
              <View>
                <Text style={styles.primary}>{item.content}</Text>
                <Text style={styles.secondary}>{`From chat · ${formatRelativeTime(item.source.at)}`}</Text>
              </View>
              <View style={styles.buttons}>
                {item.confirmed ? null : (
                  <Button
                    variant="outline"
                    label="Confirm"
                    accessibilityLabel="Confirm memory"
                    {...control("memory", `${item.itemId}:confirm`)}
                    onPress={() => void change("memory", `${item.itemId}:confirm`, () => (
                      onMemory(item.itemId, "confirm", { baseRevision: item.revision })
                    ))}
                  />
                )}
                <Button
                  variant="outline"
                  label="Forget"
                  accessibilityLabel="Forget memory"
                  {...control("memory", `${item.itemId}:forget`)}
                  onPress={() => void change("memory", `${item.itemId}:forget`, () => (
                    onMemory(item.itemId, "forget", { baseRevision: item.revision })
                  ))}
                />
              </View>
            </View>
          ))}
        </DetailsSection>
      ) : null}
      {selection ? (
        <DetailsSection testID="agent-details-model" label="Model" error={errorIn("model")}>
          <Text style={[styles.row, styles.primary]}>{botModelRoutingLabel(selection, catalog)}</Text>
          {onSelectModel ? (
            <View style={[styles.row, styles.stack]}>
              <Button
                variant="outline"
                fullWidth
                label={AUTOMATIC_MODEL}
                {...control("model", "automatic")}
                onPress={() => void change("model", "automatic", () => onSelectModel(MATRIX_BOT_SELECTION))}
              />
              {managedPiBotModelChoices(catalog).map((choice) => (
                <Button
                  key={choice.selection.model}
                  variant="outline"
                  fullWidth
                  label={choice.label}
                  {...control("model", choice.selection.model)}
                  onPress={() => void change("model", choice.selection.model, () => onSelectModel(choice.selection))}
                />
              ))}
              {blockedNativeBotModelRows(catalog).map((row) => (
                <Text
                  key={`${row.instanceId}:${row.modelId}`}
                  accessibilityRole="text"
                  accessibilityState={{ disabled: true }}
                  style={styles.secondary}
                >
                  {row.label}
                </Text>
              ))}
            </View>
          ) : null}
        </DetailsSection>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    paddingVertical: theme.v2.space[10],
  },
  split: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.v2.space[12],
  },
  stack: {
    gap: theme.v2.space[8],
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  primary: {
    ...theme.v2.text.callout,
    color: theme.v2.colors.textDefault,
  },
  secondary: {
    ...theme.v2.text.caption,
    color: theme.v2.colors.textSubtle,
  },
  buttons: {
    flexDirection: "row",
    gap: theme.v2.space[8],
  },
}));
