import AsyncStorage from "@react-native-async-storage/async-storage";
import { PostHog, PostHogMaskView } from "posthog-react-native";

/**
 * PostHog product analytics + session replay, owned in one module so screens
 * only ever touch the typed helpers below (never `posthog-react-native`
 * directly). Analytics is a NO-OP when no key is present, so local dev runs
 * keyless without any network traffic.
 *
 * Privacy posture: session replay masks all text inputs and images globally,
 * and the terminal, chat transcript, and file viewer are wrapped in
 * {@link AnalyticsMask} so their contents are never recorded. Event helpers
 * carry generic props only — no message bodies, file paths, handles, or ids.
 */

// EU PostHog org: keep the ingestion host on the EU cloud by default. The key
// is injected at build time via an EAS env/secret (EXPO_PUBLIC_POSTHOG_API_KEY);
// when it is absent every helper below no-ops.
const API_KEY = process.env.EXPO_PUBLIC_POSTHOG_API_KEY?.trim();
const HOST = process.env.EXPO_PUBLIC_POSTHOG_HOST?.trim() || "https://eu.i.posthog.com";

/**
 * Wrapper that hides its children from session replay (sets the SDK's
 * `ph-no-capture` accessibility label). Re-exported so feature code masks
 * sensitive surfaces without importing PostHog directly.
 */
export const AnalyticsMask = PostHogMaskView;

export type AnalyticsProps = Record<string, string | number | boolean | null>;

// `@react-native-async-storage/async-storage` is already compiled into the app,
// so backing persistence with it keeps PostHog off the newly-added
// expo-file-system native module — which is absent until the dev client is
// rebuilt — while still persisting across launches.
const asyncStorage = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
};

// `undefined` = not yet initialized, `null` = disabled (no key / init failed).
let client: PostHog | null | undefined;

/**
 * Lazily constructs the singleton PostHog client, or returns `null` when
 * analytics is disabled. Construction is guarded: on a dev client missing the
 * expo/native modules the SDK degrades internally, but we still fail closed to
 * `null` if anything throws so the app never crashes because of analytics.
 */
export function getAnalyticsClient(): PostHog | null {
  if (client !== undefined) return client;
  if (!API_KEY) {
    client = null;
    return client;
  }
  try {
    client = new PostHog(API_KEY, {
      host: HOST,
      customStorage: asyncStorage,
    });
  } catch (err: unknown) {
    console.warn(
      "[mobile] PostHog init failed; analytics disabled",
      err instanceof Error ? err.name : typeof err,
    );
    client = null;
  }
  return client;
}

/** Capture a product event with generic props only (never user content). */
export function capture(event: string, props?: AnalyticsProps): void {
  const ph = getAnalyticsClient();
  if (!ph) return;
  try {
    ph.capture(event, props);
  } catch (err: unknown) {
    console.warn("[mobile] analytics capture failed", err instanceof Error ? err.name : typeof err);
  }
}

/**
 * Capture a screen view. `name` MUST already be sanitized via
 * {@link sanitizeScreenName} so route ids/handles never reach PostHog.
 */
export function captureScreen(name: string, props?: AnalyticsProps): void {
  const ph = getAnalyticsClient();
  if (!ph) return;
  try {
    void ph.screen(name, props);
  } catch (err: unknown) {
    console.warn("[mobile] analytics screen failed", err instanceof Error ? err.name : typeof err);
  }
}

/** Associate subsequent events with a Clerk user id (id only — no PII). */
export function identifyUser(distinctId: string): void {
  const ph = getAnalyticsClient();
  if (!ph || !distinctId) return;
  try {
    ph.identify(distinctId);
  } catch (err: unknown) {
    console.warn("[mobile] analytics identify failed", err instanceof Error ? err.name : typeof err);
  }
}

/** Clear identity + session on sign-out so the next user starts anonymous. */
export function resetAnalytics(): void {
  const ph = getAnalyticsClient();
  if (!ph) return;
  try {
    ph.reset();
  } catch (err: unknown) {
    console.warn("[mobile] analytics reset failed", err instanceof Error ? err.name : typeof err);
  }
}

// Known static children under /agents; anything else in that slot is a thread
// id and must be collapsed.
const AGENT_STATIC_CHILDREN = new Set(["new", "preview", "providers", "reviews", "terminals", "index"]);

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// Heuristic: does a path segment look like an opaque id, handle, or token?
function looksLikeId(rawSegment: string): boolean {
  const s = safeDecode(rawSegment);
  if (s.includes("@")) return true; // handles / emails
  if (/^\d+$/.test(s)) return true; // numeric ids
  if (/^[0-9a-f]{8,}$/i.test(s)) return true; // hex / short uuids
  if (/^[0-9a-f-]{16,}$/i.test(s)) return true; // dashed uuids
  if (s.length >= 20) return true; // long opaque tokens (nanoid, base64)
  return false;
}

/**
 * Normalize an expo-router pathname into a stable, id-free screen name.
 * Dynamic route params (thread ids, app/runtime slugs, handles) are collapsed
 * to placeholders so no user identifiers reach analytics.
 */
export function sanitizeScreenName(pathname: string | null | undefined): string {
  const path = (pathname || "/").split(/[?#]/)[0];
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  const [head, second] = segments;
  if (head === "agents" && second && !AGENT_STATIC_CHILDREN.has(second)) {
    return "/agents/:threadId";
  }
  if (head === "apps" && second) return "/apps/:slug";
  if (head === "runtime" && second) return "/runtime/:slug";

  // Defense in depth: strip any remaining id-like segment.
  const safe = segments.map((seg) => (looksLikeId(seg) ? ":id" : seg));
  return "/" + safe.join("/");
}
