import React, { useEffect, useState } from "react";
import { Modal, ScrollView, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  fetchConnectedIntegrations,
  type ConnectedIntegration,
} from "@/lib/requests/integrations";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import type { EditionComputer } from "@/lib/edition/native-downloads";
import type {
  EditionSource,
  MailBridge,
} from "../../../../home/app-templates/connected-starter/src/edition/types";
import { MenuPicker } from "@/components/ui/MenuPicker";
import { EditionButton } from "./edition-ui";
import { styles } from "./edition-styles";
export function EditionSetup({
  computer,
  getToken,
  bridge,
  onClose,
  onConnected,
  existingSources = [],
}: {
  computer: EditionComputer;
  getToken(): Promise<string | null>;
  bridge: MailBridge;
  existingSources?: EditionSource[];
  onClose(): void;
  onConnected(): Promise<void>;
}) {
  const router = useRouter();
  const [connections, setConnections] = useState<ConnectedIntegration[]>([]),
    [selected, setSelected] = useState(""),
    [scope, setScope] = useState<"personal" | "work">("personal"),
    [historyMonths, setHistoryMonths] = useState(3),
    [shareWith, setShareWith] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const token = await getToken();
        if (!token) throw new Error("Authentication unavailable");
        const inventory = await fetchConnectedIntegrations(
          token,
          `${HOSTED_GATEWAY_URL}${computer.gatewayPath}`,
        );
        if (current)
          setConnections(
            inventory.filter(
              (c) =>
                c.service === "gmail" &&
                c.status === "active" &&
                c.accountEmail,
            ),
          );
      } catch {
        console.warn("Edition connections unavailable");
        if (current)
          setError("Your email connections could not be loaded. Try again.");
      }
    })();
    return () => {
      current = false;
    };
  }, [computer, getToken]);
  async function connect() {
    const connection = connections.find((c) => c.id === selected);
    if (!connection?.accountEmail) return;
    setBusy(true);
    setError("");
    try {
      await bridge("connect", {
        connectionId: connection.id,
        expectedEmail: connection.accountEmail,
        scope,
        historyMonths,
        shareWith,
      });
      await onConnected();
      onClose();
    } catch {
      console.warn("Edition account could not be added");
      setError(
        "This account could not be added. Your existing library remains available.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        style={styles.screen}
      >
        <EditionButton label="Close email setup" onPress={onClose} />
        <Text style={styles.eyebrow}>MAKE ROOM FOR GOOD IDEAS</Text>
        <Text style={styles.title}>Choose your reading source.</Text>
        <Text style={styles.body}>
          Select an exact connected email account. Choose the history range to
          import. Source read labels stay unchanged.
        </Text>
        {error && (
          <Text selectable accessibilityRole="alert" style={styles.body}>
            {error}
          </Text>
        )}
        <AccountChoices
          connections={connections}
          selected={selected}
          onSelect={(connectionId) => {
            setSelected(connectionId);
            const existing = existingSources.find(
              (source) => source.connectionId === connectionId,
            );
            setShareWith(existing?.sharedWith ?? []);
            setScope(existing?.scope ?? "personal");
          }}
        />
        {!connections.length && (
          <EditionButton
            label="Connect email in Matrix"
            onPress={() => {
              onClose();
              router.push("/(drawer)/integrations" as never);
            }}
          />
        )}
        <Text style={styles.heading}>Keep this reading in</Text>
        <View style={styles.row}>
          <EditionButton
            label="Personal"
            primary={scope === "personal"}
            onPress={() => setScope("personal")}
          />
          <EditionButton
            label="Work"
            primary={scope === "work"}
            onPress={() => setScope("work")}
          />
        </View>
        <Text style={styles.heading}>Import email history</Text>
        <MenuPicker
          accessibilityLabel="Import email history"
          options={[1, 3, 6, 12, 24].map((months) => ({
            label: `Last ${months} ${months === 1 ? "month" : "months"}`,
            value: String(months),
          }))}
          selectedValue={String(historyMonths)}
          onValueChange={(value) => setHistoryMonths(Number(value))}
        />
        <Text style={styles.heading}>Let other apps reuse saved history</Text>
        {["folio", "atlas"].map((app) => (
          <View key={app} style={styles.row}>
            <Text style={[styles.body, { flex: 1 }]}>
              {app === "folio"
                ? "Folio · receipts and expenses"
                : "Atlas · trip bookings"}
            </Text>
            <Switch
              accessibilityLabel={`Share history with ${app === "folio" ? "Folio" : "Atlas"}`}
              value={shareWith.includes(app)}
              onValueChange={(checked) =>
                setShareWith((ids) =>
                  checked ? [...ids, app] : ids.filter((id) => id !== app),
                )
              }
            />
          </View>
        ))}
        <Text style={styles.muted}>
          Sharing is optional. Each app receives only its authorized email
          evidence. No attachments are downloaded automatically. Inbox cleanup
          always starts with a separate review.
        </Text>
        <EditionButton
          label={
            busy
              ? "Adding reading source…"
              : `Add account & import ${historyMonths} ${historyMonths === 1 ? "month" : "months"}`
          }
          primary
          disabled={!selected || busy}
          onPress={() => void connect()}
        />
      </ScrollView>
    </Modal>
  );
}

function AccountChoices({
  connections,
  selected,
  onSelect,
}: {
  connections: ConnectedIntegration[];
  selected: string;
  onSelect(id: string): void;
}) {
  return (
    <View>
      {connections.map((c) => (
        <EditionButton
          key={c.id}
          primary={selected === c.id}
          label={`${c.accountEmail} · ${c.accountLabel}`}
          onPress={() => onSelect(c.id)}
        />
      ))}
    </View>
  );
}
