import React from "react";
import { createRoot } from "react-dom/client";
import { RoutineFullAccessStatusSchema, type RoutineFullAccessStatus } from "../../../packages/contracts/src/index";
import { RoutineFullAccessConsentContent } from "../../../packages/ui/src/routine-action/RoutineFullAccessConsent";
import { useRoutineFullAccess } from "../../../packages/ui/src/routine-action/use-routine-full-access";

const empty = RoutineFullAccessStatusSchema.parse({ revision: 0, eligibility: "eligible", origin: "browser_required", consent: null, challenge: null });
function fixtureClient(unavailable: boolean) {
    let view: RoutineFullAccessStatus = { ...empty, eligibility: unavailable ? "unavailable" : "eligible" };
    return { read: async () => view, challenge: async () => view = { ...view, challenge: { challengeId: `rcfull_${"a".repeat(32)}`, scopeDigest: "b".repeat(64),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), policyRevision: 0, actions: ["read", "propose", "control"],
      target: { botId: `bot_${"a".repeat(48)}`, chatId: `chat_${"b".repeat(90)}` } } },
      decide: async () => new Promise<RoutineFullAccessStatus>(() => {}), revoke: async () => empty };
}
function Card({ native = false, unavailable = false }: { native?: boolean; unavailable?: boolean }) {
  const client = React.useMemo(() => fixtureClient(unavailable), [unavailable]);
  const controller = useRoutineFullAccess({ client, chatId: "chat_fixture", identity: "fixture-owner", enabled: true,
    browserOrigin: !native, permissionMode: "full_access", onPermissionModeChange: () => {}, openOwnerBrowser: native ? async () => {} : undefined });
  return <RoutineFullAccessConsentContent controller={controller}/>;
}
createRoot(document.getElementById("root")!).render(<main style={{ maxWidth: "48rem", margin: "0 auto", padding: 16, display: "grid", gap: 24 }}>
  <p>Isolated UI fixture · no real scope, approval or account</p>
  <div data-fixture="owner"><Card/></div>
  <div data-fixture="unavailable"><Card unavailable/></div>
  <div data-fixture="native"><Card native/></div>
</main>);
