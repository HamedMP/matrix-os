import { useCallback, useEffect, useReducer, useRef } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import type { MatrixComputer } from "@matrix-os/contracts";
import { useGateway } from "@/app/_layout";
import { fetchMatrixComputers } from "@/lib/mobile-computers";
import { getSelectedGatewayConnection, saveSelectedHostedComputer } from "@/lib/storage";

const CLOUD_SIGN_IN_ERROR = "Sign in to Matrix OS Cloud to choose a computer.";
const COMPUTERS_UNAVAILABLE_ERROR = "Computers unavailable. Try again.";

type ComputerPickerState =
  | { status: "loading"; computers: MatrixComputer[]; selectedSlot: string | null; error: null }
  | { status: "ready"; computers: MatrixComputer[]; selectedSlot: string | null; error: string | null; switchingSlot?: string }
  | { status: "error"; computers: MatrixComputer[]; selectedSlot: string | null; error: string };

type ComputerPickerAction =
  | { type: "loading" }
  | { type: "loaded"; computers: MatrixComputer[]; selectedSlot: string | null }
  | { type: "failed"; error: string }
  | { type: "switching"; runtimeSlot: string }
  | { type: "switchFailed"; error: string };

const INITIAL_STATE: ComputerPickerState = {
  status: "loading",
  computers: [],
  selectedSlot: null,
  error: null,
};

function reducer(state: ComputerPickerState, action: ComputerPickerAction): ComputerPickerState {
  switch (action.type) {
    case "loading":
      return { ...state, status: "loading", error: null };
    case "loaded":
      return { status: "ready", computers: action.computers, selectedSlot: action.selectedSlot, error: null };
    case "failed":
      return { ...state, status: "error", error: action.error };
    case "switching":
      return state.status === "ready" ? { ...state, error: null, switchingSlot: action.runtimeSlot } : state;
    case "switchFailed":
      return state.status === "ready"
        ? { ...state, error: action.error, switchingSlot: undefined }
        : state;
    default:
      return state;
  }
}

export default function ComputerPickerScreen() {
  const { theme } = useUnistyles();
  const { getToken } = useAuth();
  const { setGateway } = useGateway();
  const router = useRouter();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const getTokenRef = useRef(getToken);

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const load = useCallback(async () => {
    dispatch({ type: "loading" });
    try {
      const token = await getTokenRef.current();
      if (!token) {
        dispatch({ type: "failed", error: CLOUD_SIGN_IN_ERROR });
        return;
      }
      const [result, selected] = await Promise.all([
        fetchMatrixComputers(token),
        getSelectedGatewayConnection(),
      ]);
      if (!result.ok) {
        dispatch({ type: "failed", error: result.error });
        return;
      }
      dispatch({
        type: "loaded",
        computers: result.computers,
        selectedSlot: result.selectedSlot ?? selected.runtimeSlot ?? null,
      });
    } catch (error) {
      console.warn(
        "[mobile] computer list load failed",
        error instanceof Error ? error.name : typeof error,
      );
      dispatch({ type: "failed", error: COMPUTERS_UNAVAILABLE_ERROR });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) void load();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);

  const selectComputer = useCallback(async (computer: MatrixComputer) => {
    if (computer.availability !== "available" || state.status !== "ready" || state.switchingSlot) return;
    dispatch({ type: "switching", runtimeSlot: computer.runtimeSlot });
    try {
      const gateway = await saveSelectedHostedComputer(computer);
      setGateway(gateway);
      router.back();
    } catch {
      dispatch({ type: "switchFailed", error: "Computer could not be selected. Try again." });
    }
  }, [router, setGateway, state]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Ionicons name="server-outline" size={24} color={theme.colors.primary} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>Choose computer</Text>
          <Text style={styles.subtitle}>Switch runtimes without signing out. Your data stays on the selected computer.</Text>
        </View>
      </View>

      {state.status === "loading" ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.primary} />
          <Text style={styles.statusText}>Loading computers...</Text>
        </View>
      ) : null}

      {state.error ? (
        <View style={styles.errorPanel}>
          <Text style={styles.errorText}>{state.error}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={state.error === CLOUD_SIGN_IN_ERROR ? "Sign in to choose a computer" : "Retry computer list"}
            onPress={state.error === CLOUD_SIGN_IN_ERROR
              ? () => router.replace("/sign-in" as never)
              : () => void load()}
            style={styles.retryButton}
          >
            <Text style={styles.retryText}>{state.error === CLOUD_SIGN_IN_ERROR ? "Sign in" : "Retry"}</Text>
          </Pressable>
        </View>
      ) : null}

      {state.computers.map((computer) => {
        const selected = state.selectedSlot === computer.runtimeSlot;
        const disabled = computer.availability !== "available" || state.status !== "ready" || Boolean(state.switchingSlot);
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Switch to ${computer.label}`}
            accessibilityState={{ disabled, selected }}
            disabled={disabled}
            key={`${computer.handle}:${computer.runtimeSlot}`}
            onPress={() => void selectComputer(computer)}
            style={({ pressed }) => [styles.computerCard, selected && styles.computerCardSelected, pressed && !disabled && styles.computerCardPressed, disabled && styles.computerCardDisabled]}
          >
            <View style={styles.computerTopline}>
              <View style={styles.computerTitleRow}>
                <Ionicons name={selected ? "checkmark-circle" : "desktop-outline"} size={20} color={theme.colors.primary} />
                <View>
                  <Text style={styles.computerTitle}>{computer.label}</Text>
                  <Text style={styles.computerHandle}>{computer.handle}</Text>
                </View>
              </View>
              <Text style={styles.computerStatus}>{state.status === "ready" && state.switchingSlot === computer.runtimeSlot ? "switching" : computer.availability}</Text>
            </View>
            <Text style={styles.versionLabel}>{computer.versionLabel ?? "Version pending"}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, paddingBottom: theme.spacing["2xl"], gap: theme.spacing.md },
  header: { flexDirection: "row", gap: theme.spacing.md, alignItems: "center", marginBottom: theme.spacing.sm },
  headerIcon: { width: 48, height: 48, borderRadius: theme.radius.lg, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.secondary },
  headerText: { flex: 1 },
  title: { fontFamily: theme.fonts.sansBold, fontSize: 24, color: theme.colors.foreground },
  subtitle: { marginTop: 4, fontFamily: theme.fonts.sans, fontSize: 13, lineHeight: 18, color: theme.colors.mutedForeground },
  centered: { minHeight: 180, alignItems: "center", justifyContent: "center", gap: theme.spacing.sm },
  statusText: { fontFamily: theme.fonts.sansMedium, color: theme.colors.mutedForeground },
  errorPanel: { padding: theme.spacing.lg, gap: theme.spacing.md, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.lg, backgroundColor: theme.colors.card },
  errorText: { fontFamily: theme.fonts.sansMedium, color: theme.colors.destructive },
  retryButton: { alignSelf: "flex-start", minHeight: 40, justifyContent: "center", paddingHorizontal: theme.spacing.lg, borderRadius: theme.radius.full, backgroundColor: theme.colors.primary },
  retryText: { fontFamily: theme.fonts.sansSemiBold, color: theme.colors.primaryForeground },
  computerCard: { padding: theme.spacing.lg, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radius.lg, backgroundColor: theme.colors.card, gap: theme.spacing.sm },
  computerCardSelected: { borderColor: theme.colors.primary, backgroundColor: theme.colors.secondary },
  computerCardPressed: { opacity: 0.82, transform: [{ scale: 0.99 }] },
  computerCardDisabled: { opacity: 0.55 },
  computerTopline: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: theme.spacing.md },
  computerTitleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, flex: 1 },
  computerTitle: { fontFamily: theme.fonts.sansSemiBold, fontSize: 16, color: theme.colors.foreground },
  computerHandle: { marginTop: 2, fontFamily: theme.fonts.mono, fontSize: 11, color: theme.colors.mutedForeground },
  computerStatus: { overflow: "hidden", paddingHorizontal: theme.spacing.sm, paddingVertical: 4, borderRadius: theme.radius.full, fontFamily: theme.fonts.sansMedium, fontSize: 11, color: theme.colors.primary, backgroundColor: theme.colors.background, textTransform: "capitalize" },
  versionLabel: { fontFamily: theme.fonts.mono, fontSize: 11, color: theme.colors.mutedForeground },
}));
