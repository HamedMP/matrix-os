import { useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  Text as NativeText,
  View,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import ArrowTurnBackwardIcon from "@hugeicons/core-free-icons/ArrowTurnBackwardIcon";
import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import ComputerIcon from "@hugeicons/core-free-icons/ComputerIcon";
import CreditCardIcon from "@hugeicons/core-free-icons/CreditCardIcon";
import Download01Icon from "@hugeicons/core-free-icons/Download01Icon";
import FolderDownloadIcon from "@hugeicons/core-free-icons/FolderDownloadIcon";
import IdentityCardIcon from "@hugeicons/core-free-icons/IdentityCardIcon";
import UserGroupIcon from "@hugeicons/core-free-icons/UserGroupIcon";

import { SettingsCardStack, SettingsPage, SettingsRow } from "@/components/settings/SettingsSurface";
import { Icon, Spacer, type IconData } from "@/components/ui";
import {
  APPLE_ACCESS_REMOVAL_URL,
  MATRIX_COMPUTERS_URL,
  describeAccountDeletionFailure,
  formatDeletionDeadline,
  isDeletionClosed,
  isDeletionScheduled,
  type AccountDeletionAction,
} from "@/lib/account-deletion";
import { saveAccountRecords } from "@/lib/account-records-file";
import { useAccountDeletion, useAccountExport } from "@/lib/queries/use-account-deletion";
import type { AccountDeletionStatus } from "@/lib/requests";

// The server's migration notes are long; show the first few, whole.
const MAX_EXPORT_INSTRUCTIONS = 3;

type AccountDeletion = ReturnType<typeof useAccountDeletion>;

// The OS can refuse a link (no browser, a malformed download link); that is
// logged rather than left as an unhandled rejection.
function openLink(url: string) {
  Linking.openURL(url).catch((error: unknown) => {
    console.warn("[mobile] failed to open account link", error instanceof Error ? error.name : "unknown");
  });
}

export default function DeleteAccountScreen() {
  const deletion = useAccountDeletion();
  const { theme } = useUnistyles();

  if (!deletion.enabled) {
    return (
      <SettingsPage>
        <NativeText style={styles.paragraph}>Sign in to your Matrix OS account to delete it.</NativeText>
      </SettingsPage>
    );
  }
  if (deletion.status) {
    return <DeletionDetails status={deletion.status} deletion={deletion} />;
  }
  if (deletion.isPending) {
    return (
      <SettingsPage>
        <Spacer size="3xl" />
        <ActivityIndicator testID="account-deletion-loading" color={theme.v2.appColors.ink} />
      </SettingsPage>
    );
  }
  // Without a known state there is no safe action to offer but a retry.
  return (
    <SettingsPage>
      <NativeText accessibilityRole="alert" style={styles.paragraph}>
        {describeAccountDeletionFailure(null, "load")}
      </NativeText>
      <Spacer size="lg" />
      <ActionButton label="Try again" onPress={deletion.reload} />
    </SettingsPage>
  );
}

function DeletionDetails({ status, deletion }: { status: AccountDeletionStatus; deletion: AccountDeletion }) {
  const [actionError, setActionError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const scheduled = isDeletionScheduled(status);
  const closed = isDeletionClosed(status);
  const busy = deletion.isScheduling || deletion.isCancelling;

  async function run(action: AccountDeletionAction, request: () => Promise<unknown>) {
    setActionError(null);
    try {
      await request();
      // The action button sits at the end of the page; the notice that
      // reports the new state, deadline and billing sits at the top.
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    } catch (error: unknown) {
      setActionError(describeAccountDeletionFailure(error, action));
    }
  }

  function confirmDeletion() {
    if (busy) return;
    Alert.alert(
      "Delete your account?",
      "Your account, computers and personal data will be permanently removed after five days. Billing stops now and does not restart if you cancel.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: () => void run("schedule", deletion.schedule),
        },
      ],
    );
  }

  function cancelDeletion() {
    if (busy) return;
    void run(status.billingStopped ? "cancel" : "cancel_awaiting_billing", deletion.cancel);
  }

  return (
    <SettingsPage scrollRef={scrollRef}>
      <StatusNotice status={status} />
      {scheduled || closed ? null : <Consequences />}
      {closed ? null : (
        <>
          <Spacer size="xl" />
          <DataExport />
        </>
      )}
      <Spacer size="xl" />
      <AppleAccessNote manual={status.manualAppleRevocationRequired === true} />
      {actionError ? (
        <>
          <Spacer size="lg" />
          <NativeText accessibilityRole="alert" style={styles.error}>{actionError}</NativeText>
        </>
      ) : null}
      {closed ? null : (
        <>
          <Spacer size="lg" />
          {scheduled ? (
            <ActionButton
              label="Cancel account deletion"
              busy={deletion.isCancelling}
              disabled={busy}
              onPress={cancelDeletion}
            />
          ) : (
            <ActionButton
              label="Delete account"
              tone="danger"
              busy={deletion.isScheduling}
              disabled={busy}
              onPress={confirmDeletion}
            />
          )}
        </>
      )}
    </SettingsPage>
  );
}

function StatusNotice({ status }: { status: AccountDeletionStatus }) {
  if (status.status === "none") return null;

  if (status.status === "scheduled") {
    const deadline = formatDeletionDeadline(status);
    return (
      <Notice title="Deletion scheduled" tone="warning">
        <NativeText style={styles.noticeBody}>
          {deadline
            ? `Your account, computers and personal data will be permanently removed after ${deadline}.`
            : "Your account, computers and personal data will be permanently removed when the five-day grace period ends."}
        </NativeText>
        <Spacer size="sm" />
        <NativeText style={styles.noticeBody}>
          {status.billingStopped
            ? "Future billing has stopped."
            : "Billing cancellation is pending. We’ll retry it automatically."}
        </NativeText>
        <Spacer size="sm" />
        <NativeText style={styles.noticeBody}>
          {status.billingStopped
            ? "You can cancel until deletion starts. Cancelling does not restart your subscription."
            : "You can cancel once billing has stopped. Cancelling does not restart your subscription."}
        </NativeText>
      </Notice>
    );
  }
  if (status.status === "cancelled") {
    return (
      <>
        <Notice title="Deletion cancelled">
          <NativeText style={styles.noticeBody}>
            {status.billingStopped
              ? "Your account is no longer scheduled for deletion. Your subscription was not restarted."
              : "Your account is no longer scheduled for deletion."}
          </NativeText>
        </Notice>
        <Spacer size="xl" />
      </>
    );
  }
  return (
    <Notice title={status.status === "completed" ? "Account deleted" : "Deletion in progress"}>
      <NativeText style={styles.noticeBody}>
        {status.status === "completed"
          ? "Your account has been deleted."
          : "Your account is being deleted. Data download and cancellation are closed."}
      </NativeText>
    </Notice>
  );
}

function Notice({ title, tone = "neutral", children }: {
  title: string;
  tone?: "neutral" | "warning";
  children: ReactNode;
}) {
  return (
    <View style={[styles.notice, tone === "warning" ? styles.noticeWarning : null]}>
      <NativeText accessibilityRole="header" style={styles.noticeTitle}>{title}</NativeText>
      <Spacer size="sm" />
      {children}
    </View>
  );
}

function Consequences() {
  return (
    <View style={styles.card}>
      <Consequence
        icon={Clock01Icon}
        title="Deletion starts after five days"
        body="Your account, computers and personal data are then permanently removed. Final backup cleanup can take one more day."
      />
      <Consequence
        icon={CreditCardIcon}
        title="Billing stops right away"
        body="Future subscription billing stops when you request deletion. There is no automatic refund."
      />
      <Consequence
        icon={ArrowTurnBackwardIcon}
        title="You can cancel within five days"
        body="Cancelling keeps your account, but it does not restart your subscription."
      />
      <Consequence
        icon={UserGroupIcon}
        title="Shared work stays with others"
        body="Transfer ownership of organizations and shared projects first. Other members’ data stays with them."
      />
    </View>
  );
}

function Consequence({ icon, title, body }: { icon: IconData; title: string; body: string }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.consequence}>
      <Icon icon={icon} size={21} color={theme.v2.appColors.ink} />
      <View style={styles.consequenceCopy}>
        <NativeText style={styles.consequenceTitle}>{title}</NativeText>
        <Spacer size="xs" />
        <NativeText style={styles.consequenceBody}>{body}</NativeText>
      </View>
    </View>
  );
}

function DataExport() {
  const { theme } = useUnistyles();
  const {
    files,
    instructions,
    hasMoreFiles,
    loadFiles,
    loadMoreFiles,
    isLoadingFiles,
    fetchRecords,
    isFetchingRecords,
  } = useAccountExport();
  const [exportError, setExportError] = useState<string | null>(null);
  const external = <Icon icon={ArrowUpRight01Icon} size={18} color={theme.v2.appColors.muted} />;
  const download = <Icon icon={Download01Icon} size={18} color={theme.v2.appColors.muted} />;
  const spinner = <ActivityIndicator color={theme.v2.appColors.ink} />;

  async function run(request: () => Promise<unknown>) {
    setExportError(null);
    try {
      await request();
    } catch (error: unknown) {
      console.warn("[mobile] account export failed", error instanceof Error ? error.name : "unknown");
      setExportError(describeAccountDeletionFailure(error, "export"));
    }
  }

  function getFiles(load: () => Promise<unknown>) {
    if (isLoadingFiles) return;
    void run(load);
  }

  function saveRecords() {
    if (isFetchingRecords) return;
    void run(async () => saveAccountRecords(await fetchRecords()));
  }

  return (
    <>
      <NativeText accessibilityRole="header" style={styles.sectionTitle}>Keep a copy of your data</NativeText>
      <Spacer size="xs" />
      <NativeText style={styles.sectionBody}>
        Your computers stay available until deletion starts, so you can still export from them.
      </NativeText>
      <Spacer size="md" />
      <SettingsCardStack>
        <SettingsRow
          card
          title="Backed-up files"
          detail="Download links for your synced backups"
          icon={FolderDownloadIcon}
          accessibilityLabel="Get backed-up files"
          trailing={isLoadingFiles ? spinner : download}
          onPress={() => getFiles(loadFiles)}
        />
        <SettingsRow
          card
          title="Account records"
          detail="Save your profile and account data"
          icon={IdentityCardIcon}
          accessibilityLabel="Save account records"
          trailing={isFetchingRecords ? spinner : download}
          onPress={saveRecords}
        />
        <SettingsRow
          card
          title="Open your computers"
          detail="Export unsynced files on the web"
          icon={ComputerIcon}
          accessibilityLabel="Open your computers"
          trailing={external}
          onPress={() => openLink(MATRIX_COMPUTERS_URL)}
        />
      </SettingsCardStack>
      {exportError ? (
        <>
          <Spacer size="md" />
          <NativeText accessibilityRole="alert" style={styles.error}>{exportError}</NativeText>
        </>
      ) : null}
      {files ? (
        <>
          <Spacer size="lg" />
          {files.length === 0 ? (
            // Later pages can hold backups even when the ones so far did not,
            // so "none" is only said once there is nothing left to load.
            <NativeText style={styles.sectionBody}>
              {hasMoreFiles ? "No backed-up files found so far." : "No backed-up files were found."}
            </NativeText>
          ) : null}
          {files.length > 0 || hasMoreFiles ? (
            <>
              {files.length === 0 ? <Spacer size="sm" /> : null}
              <View style={styles.card}>
                {files.map((file, index) => (
                  <FileRow
                    key={file.url}
                    first={index === 0}
                    label={file.name}
                    accessibilityLabel={`Download ${file.name}`}
                    trailing={external}
                    onPress={() => openLink(file.url)}
                  />
                ))}
                {hasMoreFiles ? (
                  <FileRow
                    first={files.length === 0}
                    label="Load more files"
                    accessibilityLabel="Load more files"
                    emphasized
                    trailing={isLoadingFiles ? spinner : null}
                    onPress={() => getFiles(loadMoreFiles)}
                  />
                ) : null}
              </View>
            </>
          ) : null}
          {files.length > 0 ? (
            <>
              <Spacer size="sm" />
              <NativeText style={styles.sectionBody}>
                Download links expire after 15 minutes. Get the list again for fresh ones.
              </NativeText>
            </>
          ) : null}
          {instructions.slice(0, MAX_EXPORT_INSTRUCTIONS).map((instruction) => (
            <View key={instruction}>
              <Spacer size="sm" />
              <NativeText style={styles.sectionBody}>{instruction}</NativeText>
            </View>
          ))}
        </>
      ) : null}
    </>
  );
}

// The separator is the row's own top border: a border on a row with height
// always lands on the pixel grid, where a zero-height hairline view can round
// away to nothing.
function FileRow({ label, accessibilityLabel, trailing, onPress, first = false, emphasized = false }: {
  label: string;
  accessibilityLabel: string;
  trailing: ReactNode;
  onPress: () => void;
  first?: boolean;
  emphasized?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.fileRow, first ? null : styles.fileRowSeparated, pressed ? styles.pressed : null]}
    >
      <NativeText style={[styles.fileName, emphasized ? styles.fileNameEmphasized : null]}>{label}</NativeText>
      {trailing}
    </Pressable>
  );
}

// Worded for after deletion on purpose: removing Apple access during the grace
// period would lock the user out of an account they can still keep.
function AppleAccessNote({ manual }: { manual: boolean }) {
  return (
    <View>
      <NativeText style={styles.sectionBody}>
        {manual
          ? "We cannot remove Matrix OS from your Apple Account automatically. After your Matrix OS account is deleted, check your Apple Account and remove Matrix OS if it is still listed. Removing Apple access on its own does not delete your Matrix OS account."
          : "Signed in with Apple? After your Matrix OS account is deleted, check your Apple Account and remove Matrix OS if it is still listed. Removing Apple access on its own does not delete your Matrix OS account."}
      </NativeText>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Apple’s instructions"
        onPress={() => openLink(APPLE_ACCESS_REMOVAL_URL)}
        style={({ pressed }) => [styles.link, pressed ? styles.pressed : null]}
      >
        <NativeText style={styles.linkText}>Apple’s instructions</NativeText>
      </Pressable>
    </View>
  );
}

function ActionButton({ label, onPress, tone = "default", busy = false, disabled = false }: {
  label: string;
  onPress: () => void;
  tone?: "default" | "danger";
  busy?: boolean;
  disabled?: boolean;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        tone === "danger" ? styles.buttonDanger : null,
        disabled ? styles.buttonDisabled : null,
        pressed ? styles.pressed : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={tone === "danger" ? theme.v2.colors.textInverse : theme.v2.appColors.ink} />
      ) : null}
      <NativeText style={[styles.buttonLabel, tone === "danger" ? styles.buttonLabelDanger : null]}>
        {label}
      </NativeText>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  paragraph: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 15,
    lineHeight: 22,
    color: theme.v2.appColors.ink,
  },
  notice: {
    padding: 16,
    borderWidth: 1,
    borderColor: theme.v2.appColors.line,
    borderRadius: 16,
    backgroundColor: theme.v2.appColors.surface,
  },
  noticeWarning: {
    backgroundColor: theme.v2.appColors.warmSurface,
  },
  noticeTitle: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 17,
    color: theme.v2.appColors.ink,
  },
  noticeBody: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: theme.v2.appColors.ink,
  },
  card: {
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.v2.appColors.line,
    borderRadius: 16,
    backgroundColor: theme.v2.appColors.surface,
  },
  consequence: {
    flexDirection: "row",
    columnGap: 13,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  fileRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    columnGap: 13,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  fileRowSeparated: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.v2.appColors.line,
  },
  fileName: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.v2.fonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: theme.v2.appColors.ink,
  },
  fileNameEmphasized: {
    fontFamily: theme.v2.fonts.semibold,
  },
  consequenceCopy: {
    flex: 1,
    minWidth: 0,
  },
  consequenceTitle: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 15,
    color: theme.v2.appColors.ink,
  },
  consequenceBody: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 13,
    lineHeight: 18,
    color: theme.v2.appColors.muted,
  },
  sectionTitle: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 16,
    color: theme.v2.appColors.ink,
  },
  sectionBody: {
    fontFamily: theme.v2.fonts.body,
    fontSize: 13,
    lineHeight: 18,
    color: theme.v2.appColors.muted,
  },
  error: {
    fontFamily: theme.v2.fonts.medium,
    fontSize: 13,
    lineHeight: 18,
    color: theme.v2.colors.danger,
  },
  link: {
    alignSelf: "flex-start",
    minHeight: 44,
    justifyContent: "center",
  },
  linkText: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 13,
    color: theme.v2.appColors.ink,
    textDecorationLine: "underline",
  },
  button: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    columnGap: 10,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: theme.v2.appColors.line,
    borderRadius: theme.v2.radius.control,
    backgroundColor: theme.v2.appColors.surface,
  },
  // Only the destructive action is filled; ink on surface keeps the neutral
  // ones readable in both colour schemes.
  buttonDanger: {
    borderColor: theme.v2.colors.danger,
    backgroundColor: theme.v2.colors.danger,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  buttonLabel: {
    fontFamily: theme.v2.fonts.semibold,
    fontSize: 16,
    color: theme.v2.appColors.ink,
  },
  buttonLabelDanger: {
    color: theme.v2.colors.textInverse,
  },
  pressed: {
    opacity: 0.7,
  },
}));
