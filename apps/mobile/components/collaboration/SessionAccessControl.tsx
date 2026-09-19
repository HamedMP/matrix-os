import type { CollaborationMember, CollaborationScope } from "@matrix-os/contracts/collaboration";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  changeCollaborationMemberRole,
  fetchCollaborationMembers,
  fetchCollaborationScope,
  inviteCollaborationMember,
  removeCollaborationMember,
  revokeCollaborationInvitation,
} from "@/lib/requests/collaboration";

export function SessionAccessControl({ scope, getToken }: {
  scope: CollaborationScope;
  getToken: () => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [currentScope, setCurrentScope] = useState(scope);
  const [members, setMembers] = useState<CollaborationMember[]>([]);
  const [identifier, setIdentifier] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("editor");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [feedback, setFeedback] = useState("");
  const refreshGeneration = useRef(0);
  const mutationGeneration = useRef(0);

  useEffect(() => () => {
    refreshGeneration.current += 1;
    mutationGeneration.current += 1;
  }, []);

  const loadAccess = useCallback(async () => {
    const token = await getToken();
    const [nextScope, result] = await Promise.all([
      fetchCollaborationScope(token, scope.id),
      fetchCollaborationMembers(token, scope.id),
    ]);
    return { scope: nextScope, members: result.members };
  }, [getToken, scope.id]);
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const result = await loadAccess();
    if (generation !== refreshGeneration.current) return;
    setCurrentScope(result.scope);
    setMembers(result.members);
  }, [loadAccess]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setError(false);
    void loadAccess().then((result) => {
      if (!current) return;
      setCurrentScope(result.scope);
      setMembers(result.members);
    }).catch((failure: unknown) => {
        console.warn("[mobile-collaboration] access load failed", failure instanceof Error ? failure.name : "UnknownError");
        if (current) setError(true);
      }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [loadAccess, open]);

  const mutate = async (operation: (token: string) => Promise<unknown>, message: string) => {
    const generation = ++mutationGeneration.current;
    setPending(true);
    setError(false);
    setFeedback("");
    try {
      await operation(await getToken());
      await refresh();
      if (generation !== mutationGeneration.current) return;
      setFeedback(message);
    } catch (failure: unknown) {
      console.warn("[mobile-collaboration] access update failed", failure instanceof Error ? failure.name : "UnknownError");
      if (generation === mutationGeneration.current) setError(true);
    } finally {
      if (generation === mutationGeneration.current) setPending(false);
    }
  };
  const invite = async () => {
    const target = identifier.trim();
    if (!target) return;
    await mutate((token) => inviteCollaborationMember(
      token, currentScope.id, target, inviteRole, currentScope.revision, randomUuid(),
    ), "Invitation sent. Access starts after acceptance.");
    setIdentifier("");
  };
  const changeRole = (member: CollaborationMember) => {
    const nextRole = member.role === "editor" ? "viewer" : "editor";
    void mutate((token) => changeCollaborationMemberRole(
      token, currentScope.id, member.actor.actorId, nextRole, currentScope.revision, member.revision, randomUuid(),
    ), `${member.actor.displayName} is now a ${nextRole}.`);
  };
  const remove = (member: CollaborationMember) => {
    const operation = member.status === "pending" && member.invitationId
      ? (token: string) => revokeCollaborationInvitation(
        token, currentScope.id, member.invitationId!, currentScope.revision, member.revision, randomUuid(),
      )
      : (token: string) => removeCollaborationMember(
        token, currentScope.id, member.actor.actorId, currentScope.revision, member.revision, randomUuid(),
      );
    void mutate(operation, member.status === "pending" ? "Invitation revoked." : "Collaborator removed.");
  };
  const close = () => {
    if (pending) return;
    setOpen(false);
    setManaging(false);
    setFeedback("");
  };

  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="Collaboration access"
      accessibilityState={{ expanded: open }} onPress={() => setOpen(true)} style={styles.trigger}>
      <View style={styles.avatar}><Text style={styles.avatarText}>S</Text></View>
      <Text style={styles.triggerText}>{scope.membershipMode === "inherited" ? "Project access" : "Shared"}</Text>
    </Pressable>
    <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.overlay}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close access" style={styles.backdrop} onPress={close} />
        <View accessibilityViewIsModal style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text accessibilityRole="header" style={styles.title}>{managing ? "Manage access" : "Access"}</Text>
              <Text style={styles.muted}>{currentScope.role === "owner" ? "You are the owner." : `You are an ${currentScope.role}.`}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close access panel" onPress={close} style={styles.secondary}>
              <Text style={styles.secondaryText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            {loading ? <Text accessibilityRole="text" style={styles.muted}>Loading people…</Text> : null}
            {managing && currentScope.capabilities.manageMembers && currentScope.membershipMode === "direct" ? <View style={styles.inviteCard}>
              <Text style={styles.sectionTitle}>Invite a person</Text>
              <TextInput accessibilityLabel="Email or username" autoCapitalize="none" autoCorrect={false}
                editable={!pending} value={identifier} onChangeText={setIdentifier}
                placeholder="name@example.com or @username" style={styles.input} />
              <View style={styles.roleRow}>
                {(["editor", "viewer"] as const).map((role) => <Pressable key={role} accessibilityRole="button"
                  accessibilityLabel={`Invite as ${role}`} accessibilityState={{ selected: inviteRole === role }}
                  disabled={pending} onPress={() => setInviteRole(role)}
                  style={[styles.roleChoice, inviteRole === role && styles.roleChoiceActive]}>
                  <Text style={styles.secondaryText}>{roleLabel(role)}</Text>
                </Pressable>)}
              </View>
              <PrimaryAction label={pending ? "Sending…" : "Send invitation"} disabled={pending || !identifier.trim()} onPress={() => void invite()} />
              <Text style={styles.muted}>Invite access applies only to this session. Projects, sibling resources, files, and credentials stay private.</Text>
            </View> : null}
            <Text style={styles.sectionTitle}>People with access</Text>
            {!loading && members.length === 0 ? <Text style={styles.muted}>No collaborators yet.</Text> : null}
            {members.map((member) => <View key={member.actor.actorId} style={styles.member}>
              <View style={styles.memberCopy}>
                <Text style={styles.memberName}>{member.actor.displayName}</Text>
                <Text style={styles.muted}>{member.status === "pending" ? "Invitation pending" : roleLabel(member.role)}</Text>
              </View>
              {managing && member.role !== "owner" ? <>
                {member.status === "accepted" ? <Pressable accessibilityRole="button"
                  accessibilityLabel={`Change role for ${member.actor.displayName}`} disabled={pending}
                  onPress={() => changeRole(member)} style={styles.secondary}>
                  <Text style={styles.secondaryText}>{member.role === "editor" ? "Make viewer" : "Make editor"}</Text>
                </Pressable> : null}
                <Pressable accessibilityRole="button"
                  accessibilityLabel={`${member.status === "pending" ? "Revoke invitation for" : "Remove"} ${member.actor.displayName}`}
                  disabled={pending} onPress={() => remove(member)} style={styles.secondary}>
                  <Text style={styles.secondaryText}>{member.status === "pending" ? "Revoke" : "Remove"}</Text>
                </Pressable>
              </> : <Text style={styles.role}>{roleLabel(member.role)}</Text>}
            </View>)}
            {!managing && currentScope.capabilities.manageMembers && currentScope.membershipMode === "direct"
              ? <PrimaryAction label="Manage access" onPress={() => setManaging(true)} /> : null}
            {managing ? <Pressable accessibilityRole="button" accessibilityLabel="Back to access summary"
              disabled={pending} onPress={() => setManaging(false)} style={styles.secondary}>
              <Text style={styles.secondaryText}>Back</Text>
            </Pressable> : null}
            {error ? <Text accessibilityRole="alert" style={styles.error}>Access details are unavailable. Try again.</Text> : null}
            {feedback ? <Text accessibilityRole="text" style={styles.muted}>{feedback}</Text> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  </>;
}

function PrimaryAction({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={[styles.primary, disabled && styles.faded]}><Text style={styles.primaryText}>{label}</Text></Pressable>;
}

function roleLabel(role: CollaborationMember["role"]): string {
  return role[0]!.toUpperCase() + role.slice(1);
}

function randomUuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const styles = StyleSheet.create((theme) => ({
  trigger: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 10 },
  avatar: { width: 21, height: 21, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 999 },
  avatarText: { fontFamily: theme.v2.fonts.semibold, fontSize: 10, color: theme.v2.appColors.ink },
  triggerText: { fontFamily: theme.v2.fonts.semibold, fontSize: 12, color: theme.v2.appColors.muted },
  overlay: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0, 0, 0, 0.24)" },
  sheet: { maxHeight: "92%", borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: theme.v2.appColors.canvas, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderBottomWidth: 1, borderBottomColor: theme.v2.colors.borderSubtle },
  headerCopy: { flex: 1, gap: 2 },
  title: { fontFamily: theme.v2.fonts.semibold, fontSize: 18, color: theme.v2.appColors.ink },
  content: { gap: 12, padding: 16 },
  muted: { fontFamily: theme.v2.fonts.body, fontSize: 12, lineHeight: 17, color: theme.v2.appColors.muted },
  sectionTitle: { fontFamily: theme.v2.fonts.semibold, fontSize: 15, color: theme.v2.appColors.ink },
  inviteCard: { gap: 10, padding: 14, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 16 },
  input: { paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 12, color: theme.v2.appColors.ink, fontFamily: theme.v2.fonts.body },
  roleRow: { flexDirection: "row", gap: 8 },
  roleChoice: { flex: 1, alignItems: "center", padding: 9, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 10 },
  roleChoiceActive: { backgroundColor: theme.v2.appColors.soft },
  member: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, padding: 12, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 14 },
  memberCopy: { minWidth: 120, flex: 1 },
  memberName: { fontFamily: theme.v2.fonts.semibold, fontSize: 14, color: theme.v2.appColors.ink },
  role: { fontFamily: theme.v2.fonts.body, fontSize: 12, color: theme.v2.appColors.muted },
  primary: { alignItems: "center", paddingHorizontal: 14, paddingVertical: 11, borderRadius: 12, backgroundColor: theme.v2.palette.green[800] },
  primaryText: { fontFamily: theme.v2.fonts.semibold, color: theme.v2.colors.textInverse },
  secondary: { alignItems: "center", paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 10 },
  secondaryText: { fontFamily: theme.v2.fonts.semibold, fontSize: 12, color: theme.v2.appColors.ink },
  error: { fontFamily: theme.v2.fonts.semibold, fontSize: 13, color: theme.v2.colors.textDefault },
  faded: { opacity: 0.5 },
}));
