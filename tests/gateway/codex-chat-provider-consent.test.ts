import { expect, it } from "vitest";
import type {
  CanonicalProviderInstanceDescriptor,
  ProviderSettingsSnapshot,
} from "@matrix-os/contracts";
import { applyHarnessSettings } from "../../packages/gateway/src/chat/harness-catalog-admission.js";

const codexInstance = {
  id: "codex_default",
  driverKind: "codex",
  displayName: "Codex",
  availability: "available",
  workspaceRequirement: "project_optional",
  models: [{
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    availability: "available",
    capabilities: ["tools"],
    supportsVision: false,
    supportsToolUse: true,
  }],
  options: [],
  skills: [],
  commands: [],
  setupActions: [{
    id: "codex_connect",
    kind: "foreground_terminal",
    label: "Connect Codex",
    command: "codex login --device-auth",
  }],
  supports: {
    rootChat: true,
    resume: true,
    cancellation: true,
    attachments: [],
    tools: [],
    approvals: true,
    userInput: false,
    worktrees: "optional",
    resources: [],
    interactionModes: ["default"],
    permissionModes: ["supervised"],
  },
  defaultSelection: { instanceId: "codex_default", model: "gpt-5.4" },
} satisfies Omit<CanonicalProviderInstanceDescriptor, "catalogRevision">;

const settings = {
  harnesses: [{
    id: "harness_codex",
    harness: "codex",
    displayName: "Codex",
    accentColor: null,
    enabled: false,
    configuredEnabled: true,
    version: null,
    installState: "installed",
    authState: "authenticated",
    loginMethods: ["terminal"],
    connectivity: "online",
    accountIds: ["owner_codex"],
    selectedAccountId: "owner_codex",
    accessSourceId: "owner_openai_profile",
    route: { kind: "fixed", providerId: "openai", modelId: "gpt-5.4" },
    activeChatCount: 0,
  }],
  accessSources: [{
    id: "owner_openai_profile",
    kind: "provider_account",
    providerId: "openai",
    accountId: "owner_codex",
    fundingKind: "owner_account",
    displayName: "Owner Codex account",
    eligibleModelIds: ["gpt-5.4"],
    readiness: {
      state: "auth_required",
      checkedAt: "2026-10-20T19:40:00.000Z",
      staleAfter: "2026-10-20T19:40:30.000Z",
      action: "connect",
      safeReason: "auth",
    },
    usage: {
      kind: "unavailable",
      authority: "unavailable",
      state: "not_applicable",
      scope: "account",
      reason: "provider_does_not_report",
      asOf: null,
    },
  }],
} as ProviderSettingsSnapshot;

it("does not advertise a configured Codex subscription without executable consent", () => {
  const [codex] = applyHarnessSettings({
    systemRepairAction: () => ({
      id: "system_repair",
      kind: "foreground_terminal",
      label: "Repair",
      command: "true",
    }),
    now: new Date("2026-10-20T19:40:10.000Z"),
    instances: [codexInstance],
    settings,
    settingsRequired: true,
    settingsAvailable: true,
    executableDriverKinds: ["codex"],
  });

  expect(codex).toMatchObject({
    availability: "unavailable",
    unavailabilityReason: "authentication_required",
    defaultSelection: undefined,
    setupActions: [{ id: "codex_settings", kind: "open_settings", label: "Agents & providers" }],
  });
});
