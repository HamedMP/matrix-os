import { expect, it } from "vitest";
import { normalizeHermesRuntimeSnapshot } from "../../packages/gateway/src/agent-config/hermes-source.js";
import { projectHermesNativeCatalog } from "../../packages/gateway/src/ai-providers/hermes-native-catalog.js";
import { projectHermesObservationForRenewal } from "../../packages/gateway/src/ai-providers/hermes-observation-renewal.js";

const now = new Date(6000);
const provider = (slug: string) => ({ slug, authenticated: true, is_user_defined: false,
  auth_type: slug === "openai-codex" ? "oauth" : "api_key", models: ["native-model"] });
const snapshot = () => normalizeHermesRuntimeSnapshot({ observedAt: 0, status: { gateway_running: false },
  options: { provider: "openrouter", model: "native-model", providers: [provider("openrouter"), provider("openai-api")] } });

it("recovers each historical positive route without making expired evidence live or changing the native selection", () => {
  const value = snapshot();
  const original = structuredClone(value);
  const historical = projectHermesObservationForRenewal(value, now);
  expect(historical.profiles.map(profile => profile.providerId)).toEqual(["openai-api", "openrouter"]);
  expect(historical.profiles.every(profile => Date.parse(profile.localObservation.staleAfter!) <= +now)).toBe(true);
  expect(projectHermesNativeCatalog(value, now).profiles).toEqual([]);
  expect(value).toEqual(original);
});

it("retains a fresh profile while recovering a different expired positive observation", () => {
  const value = snapshot();
  value.nativeProfileObservations!.find(profile => profile.providerId === "openai-api")!.localObservation = {
    state: "present_unverified", checkedAt: new Date(4000).toISOString(), staleAfter: new Date(9000).toISOString(),
  };
  expect(projectHermesNativeCatalog(value, now).profiles.map(profile => profile.providerId)).toEqual(["openai-api"]);
  expect(projectHermesObservationForRenewal(value, now).profiles.map(profile => profile.providerId)).toEqual(["openai-api", "openrouter"]);
});

it.each(["absent", "unknown", "custom", "duplicate", "unauthenticated", "future", "overlong", "reversed"])(
  "does not recover %s evidence merely because it is old", reason => {
    const value = snapshot();
    const observation = value.runtime.options.find(runtime => runtime.id === "hermes")!.nativeRouteObservation!;
    if (reason === "absent" || reason === "unknown") observation.localObservation.state = reason;
    if (reason === "custom") observation.credentialKind = "custom";
    if (reason === "duplicate") value.providers.push(structuredClone(value.providers.find(profile => profile.id === "openrouter")!));
    if (reason === "unauthenticated") value.providers.find(profile => profile.id === "openrouter")!.authStatus.authenticated = false;
    if (reason === "future") observation.localObservation.checkedAt = new Date(7000).toISOString();
    if (reason === "overlong") observation.localObservation.staleAfter = new Date(5500).toISOString();
    if (reason === "reversed") observation.localObservation.staleAfter = new Date(-1).toISOString();
    expect(projectHermesObservationForRenewal(value, now).profiles.some(profile => profile.providerId === "openrouter")).toBe(false);
  },
);
