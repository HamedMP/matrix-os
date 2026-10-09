import { Alert, Linking, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import Message01Icon from "@hugeicons/core-free-icons/Message01Icon";
import {
  whatsAppSettingsView,
  WHATSAPP_AI_GUIDANCE,
  WHATSAPP_AGENT_GUIDANCE,
  WHATSAPP_CONNECT_URL,
  WHATSAPP_GUIDE_URL,
} from "@matrix-os/contracts";
import { SLACK_INSTALL_URL } from "@matrix-os/contracts/slack-bridge";
import {
  SettingsCardStack,
  SettingsPage,
  SettingsRow,
} from "@/components/settings/SettingsSurface";
import { useWhatsAppSettings } from "@/lib/queries/use-whatsapp-settings";
async function open(url: string) {
  try {
    await Linking.openURL(url);
  } catch (error) {
    console.warn(
      "[messaging] Browser unavailable",
      error instanceof Error ? error.name : "UnknownError",
    );
    Alert.alert("Could not open this link", "Try again in a moment.");
  }
}
export default function MessagingSettingsScreen() {
  const router = useRouter();
  const {
    data: loaded,
    isPending,
    isFetching,
    isError,
    refetch,
  } = useWhatsAppSettings();
  const { snapshot: data, label } = whatsAppSettingsView(
    loaded,
    isPending || isFetching,
    isError,
  );
  return (
    <SettingsPage>
      <View style={styles.copy}>
        <Text style={styles.title}>WhatsApp</Text>
        <Text style={styles.body}>{label}</Text>
        {data?.connected && (
          <Text style={styles.body}>{data.maskedSender}</Text>
        )}
        <Text style={styles.body}>
          Message your own Matrix assistant from WhatsApp. Conversations stay in
          your private Matrix Chat.
        </Text>
        {data?.admission === "pilot" && (
          <Text style={styles.body}>
            WhatsApp is available to invited accounts during the pilot.
          </Text>
        )}
        <Text style={styles.body}>{WHATSAPP_AI_GUIDANCE}</Text>
        <Text style={styles.body}>{WHATSAPP_AGENT_GUIDANCE}</Text>
      </View>
      <SettingsCardStack>
        {data?.chatId && (
          <SettingsRow card title="Open Matrix Chat" detail="View messages or change the selected agent"
            onPress={() => router.push({ pathname: "/open", params: { chat: data.chatId! } })} />
        )}
        {isError && (
          <SettingsRow
            card
            title="Try again"
            detail="Could not check your connection"
            onPress={() => void refetch()}
          />
        )}
        {data?.startUrl && (
          <SettingsRow
            card
            title="Open WhatsApp"
            icon={Message01Icon}
            onPress={() => void open(data.startUrl!)}
          />
        )}
        {data && data.admission !== "unavailable" && (
          <SettingsRow
            card
            title={data.connected ? "Manage connection" : "Connect WhatsApp"}
            detail="Confirm your account securely in the browser"
            onPress={() => void open(WHATSAPP_CONNECT_URL)}
          />
        )}
        <SettingsRow
          card
          title="WhatsApp connection guide"
          onPress={() => void open(WHATSAPP_GUIDE_URL)}
        />
      </SettingsCardStack>
      <View style={[styles.copy, { marginTop: 32 }]}>
        <Text style={styles.title}>Slack</Text>
        <Text style={styles.body}>
          Message your personal assistant privately, or use your company
          assistant in a connected channel.
        </Text>
      </View>
      <SettingsCardStack>
        <SettingsRow
          card
          title="Add to Slack"
          detail="Install for your organization, then send connect to Matrix"
          icon={Message01Icon}
          onPress={() => void open(SLACK_INSTALL_URL)}
        />
        <SettingsRow
          card
          title="Slack connection guide"
          onPress={() => void open("https://matrix-os.com/docs/slack-company-brain")}
        />
      </SettingsCardStack>
    </SettingsPage>
  );
}
const styles = StyleSheet.create((theme) => ({
  copy: { gap: 12, marginBottom: 24 },
  title: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 24,
    color: theme.v2.appColors.ink,
  },
  body: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 15,
    lineHeight: 22,
    color: theme.v2.appColors.muted,
  },
}));
