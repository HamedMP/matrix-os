import {
  CollaborationEventFrameSchema,
  type CollaborationProject,
  type CollaborationScope,
} from "@matrix-os/contracts/collaboration";
import { useEffect, useReducer, useRef } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  CollaborationRecoverySupersededError,
  useSharedProjectWorkflow,
} from "./useSharedProjectWorkflow";
import {
  collaborationEventsUrl,
  fetchCollaborationEventTicket,
} from "@/lib/requests/collaboration";

type ProjectState = {
  scope: CollaborationScope | null;
  project: CollaborationProject | null;
  loading: boolean;
  error: string;
};

const initialState: ProjectState = { scope: null, project: null, loading: true, error: "" };

export function SharedProjectScreen({
  scopeId,
  getToken,
  onBack,
}: {
  scopeId: string;
  getToken: () => Promise<string>;
  onBack: () => void;
}) {
  const [state, dispatch] = useReducer(
    (current: ProjectState, action: { type: "patch"; patch: Partial<ProjectState> }) => ({ ...current, ...action.patch }),
    initialState,
  );
  const eventSequenceRef = useRef("0");
  const eventScopeRef = useRef<string | null>(null);
  const { invalidateProject, loadProject, markUnavailable, refreshLiveProject } = useSharedProjectWorkflow({
    token: getToken,
    dispatch,
    eventScopeRef,
    eventSequenceRef,
  });

  useEffect(() => {
    void loadProject(scopeId);
    return invalidateProject;
  }, [invalidateProject, loadProject, scopeId]);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const retry = (connect: () => Promise<void>) => {
      const delay = Math.min(10_000, 500 * (2 ** Math.min(attempt, 5)));
      attempt += 1;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { void connect(); }, delay);
    };
    const connect = async () => {
      try {
        const actorToken = await getToken();
        const ticket = await fetchCollaborationEventTicket(actorToken, scopeId, randomUuid());
        if (closed) return;
        const NativeWebSocket = WebSocket as unknown as new (
          target: string,
          protocols?: string | string[],
          options?: { headers: Record<string, string> },
        ) => WebSocket;
        const next = new NativeWebSocket(
          collaborationEventsUrl(scopeId, ticket.ticket, eventSequenceRef.current),
          undefined,
          { headers: { Authorization: `Bearer ${actorToken}` } },
        );
        socket = next;
        let usable = true;
        let refreshQueue = Promise.resolve();
        const enqueueAfterRecovery = (operation: () => void | Promise<void>) => {
          refreshQueue = refreshQueue.then(async () => {
            if (!usable || closed) return;
            await operation();
          }).catch((failure: unknown) => {
            if (failure instanceof CollaborationRecoverySupersededError) return;
            console.warn("[mobile-collaboration] project realtime refresh failed", failure instanceof Error ? failure.name : "UnknownError");
            if (!closed && eventScopeRef.current === scopeId) {
              dispatch({ type: "patch", patch: { error: "This shared project could not be refreshed. Try again." } });
            }
            if (usable && !closed) {
              usable = false;
              next.close(1011, "Refresh failed");
            }
          });
        };
        next.onopen = () => { attempt = 0; };
        next.onmessage = (event) => {
          if (!usable) return;
          if (typeof event.data !== "string" || event.data.length > 64 * 1024) {
            next.close(1008, "Invalid frame");
            return;
          }
          try {
            const frame = CollaborationEventFrameSchema.parse(JSON.parse(event.data) as unknown);
            if (frame.scopeId !== scopeId) throw new Error("ScopeMismatch");
            if (frame.type === "heartbeat") {
              if (next.readyState === WebSocket.OPEN) next.send(JSON.stringify({ version: 1, type: "heartbeat" }));
              enqueueAfterRecovery(() => { eventSequenceRef.current = frame.sequence; });
            } else if (frame.type === "ready") {
              enqueueAfterRecovery(() => { eventSequenceRef.current = frame.sequence; });
            } else if (frame.type === "unavailable") {
              closed = true;
              eventScopeRef.current = null;
              markUnavailable();
              next.close(1008, "Unavailable");
            } else if (frame.type === "changed" || frame.type === "capabilities_changed" || frame.type === "refresh_required") {
              enqueueAfterRecovery(async () => {
                await refreshLiveProject(scopeId);
                if (usable && !closed) eventSequenceRef.current = frame.sequence;
              });
            }
          } catch (failure: unknown) {
            console.warn("[mobile-collaboration] project event frame rejected", failure instanceof Error ? failure.name : "UnknownError");
            next.close(1008, "Invalid frame");
          }
        };
        next.onerror = () => next.close();
        next.onclose = () => {
          usable = false;
          if (socket === next) socket = null;
          if (!closed) retry(connect);
        };
      } catch (failure: unknown) {
        console.warn("[mobile-collaboration] project event connection failed", failure instanceof Error ? failure.name : "UnknownError");
        if (!closed) retry(connect);
      }
    };
    void connect();
    return () => {
      closed = true;
      eventScopeRef.current = null;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close(1000, "Closed");
    };
  }, [getToken, markUnavailable, refreshLiveProject, scopeId]);

  return <ScrollView contentContainerStyle={styles.page}>
    <Pressable accessibilityRole="button" accessibilityLabel="Back to Shared with me" onPress={onBack}>
      <Text style={styles.back}>‹ Shared with me</Text>
    </Pressable>
    <Text style={styles.title}>{state.project?.id ?? "Shared project"}</Text>
    <Text style={styles.muted}>{state.scope
      ? `${roleLabel(state.scope.role)} · ${state.scope.role === "viewer" ? "read only" : "can edit"}`
      : "Loading…"}</Text>
    {state.loading ? <ActivityIndicator accessibilityLabel="Loading shared project" /> : null}
    {state.error ? <Text accessibilityRole="alert" style={styles.error}>{state.error}</Text> : null}
    {state.project?.resources.map((resource) => <View key={`${resource.kind}:${resource.id}`} style={styles.card}>
      <Text style={styles.cardTitle}>{resource.id}</Text>
      <Text style={styles.muted}>{resource.kind} · {resource.readiness}</Text>
    </View>)}
  </ScrollView>;
}

function roleLabel(role: "owner" | "editor" | "viewer"): string {
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
  page: { flexGrow: 1, gap: 16, padding: 20, backgroundColor: theme.v2.appColors.canvas },
  title: { fontFamily: theme.v2.fonts.display, fontSize: 26, color: theme.v2.appColors.ink },
  muted: { fontFamily: theme.v2.fonts.body, fontSize: 13, lineHeight: 19, color: theme.v2.appColors.muted },
  error: { fontFamily: theme.v2.fonts.semibold, fontSize: 13, color: theme.v2.colors.textDefault },
  card: { gap: 10, padding: 16, borderWidth: 1, borderColor: theme.v2.colors.borderSubtle, borderRadius: 16, backgroundColor: theme.v2.appColors.surface },
  cardTitle: { fontFamily: theme.v2.fonts.semibold, fontSize: 15, color: theme.v2.appColors.ink },
  back: { fontFamily: theme.v2.fonts.semibold, color: theme.v2.colors.action },
}));
