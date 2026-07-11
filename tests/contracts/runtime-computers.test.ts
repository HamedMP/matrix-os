import { describe, expect, it } from "vitest";
import {
  MatrixComputerListSchema,
  MatrixComputerSchema,
} from "@matrix-os/contracts";

const mainComputer = {
  handle: "neo",
  runtimeSlot: "primary",
  label: "Main Computer",
  availability: "available",
  kind: "customer",
  versionLabel: "v2026.07.11",
  gatewayPath: "/vm/neo",
  capabilities: ["matrixComputerInventoryV1", "codingAgentsTranscriptPages"],
} as const;

const documentedCapabilities = [
  "codingAgentsRuntimeSummary",
  "codingAgentsDesktopWorkspace",
  "codingAgentsMobileWorkspace",
  "codingAgentsThreadCreate",
  "codingAgentsApprovals",
  "codingAgentsReview",
  "codingAgentsPreview",
  "codingAgentsFiles",
  "codingAgentsSourceControl",
  "codingAgentsNativeMobileTerminal",
  "codingAgentsProjectWorkspace",
  "codingAgentsSameThreadTurns",
  "codingAgentsConversationView",
  "codingAgentsKanbanView",
  "codingAgentsTranscriptPages",
  "codingAgentsSessionDiscovery",
  "codingAgentsSessionLifecycle",
  "codingAgentsPendingQueue",
  "codingAgentsSteering",
  "codingAgentsTurnInterrupt",
  "codingAgentsProviderControls",
  "codingAgentsProfiles",
  "codingAgentsExecutionGraph",
  "codingAgentsTerminalBindingsV2",
  "codingAgentsRepositoryState",
  "codingAgentsSourceControlV2",
  "codingAgentsReviewComments",
  "codingAgentsAttachments",
  "codingAgentsAttentionInbox",
  "codingAgentsRuntimeHandoff",
  "codingAgentsCollaboration",
  "codingAgentsPromptAssets",
  "codingAgentsUsageSummary",
  "matrixComputerInventoryV1",
  "matrixNativeIdentityProjection",
  "codingAgentsMemorySearch",
  "codingAgentsAutomations",
  "codingAgentsVoiceActions",
  "codingAgentsFeaturePolicy",
  "codingAgentsRecovery",
  "codingAgentsDiagnosticsSnapshot",
] as const;

describe("Matrix computer contracts", () => {
  it("accepts one bounded owner inventory with authoritative top-level selection", () => {
    const response = MatrixComputerListSchema.parse({
      items: [
        mainComputer,
        {
          ...mainComputer,
          handle: "pr-920",
          runtimeSlot: "pr-920",
          label: "Preview Computer",
          availability: "starting",
          kind: "preview",
          versionLabel: "Version pending",
          gatewayPath: "/vm/pr-920?runtime=pr-920",
          capabilities: ["matrixComputerInventoryV1"],
        },
      ],
      selectedSlot: "primary",
      hasMore: false,
      limit: 20,
    });

    expect(response.items).toHaveLength(2);
    expect(response.selectedSlot).toBe("primary");
    expect(response.items[1]?.gatewayPath).toBe("/vm/pr-920?runtime=pr-920");
  });

  it("represents a verified principal without an authoritative runtime selection", () => {
    const response = MatrixComputerListSchema.parse({
      items: [mainComputer],
      selectedSlot: null,
      hasMore: false,
      limit: 20,
    });

    expect(response.selectedSlot).toBeNull();
  });

  it("accepts the complete additive capability roster", () => {
    const computer = MatrixComputerSchema.parse({
      ...mainComputer,
      capabilities: documentedCapabilities,
    });

    expect(computer.capabilities).toHaveLength(41);
  });

  it("rejects mismatched routes, unsafe fields, client selection, and unbounded lists", () => {
    expect(MatrixComputerSchema.safeParse({
      ...mainComputer,
      gatewayPath: "/vm/someone-else",
    }).success).toBe(false);

    for (const leaked of [
      { machineId: "machine-secret" },
      { publicIPv4: "203.0.113.12" },
      { accessToken: "secret" },
      { provider: "infrastructure-vendor" },
      { providerState: { authenticated: true } },
      { privateHostname: "db.internal" },
      { operatorMetadata: { serverType: "cpx22" } },
      { credentials: { accessToken: "secret" } },
      { selected: true },
    ]) {
      expect(MatrixComputerSchema.safeParse({ ...mainComputer, ...leaked }).success).toBe(false);
    }

    expect(MatrixComputerListSchema.safeParse({
      items: Array.from({ length: 21 }, (_, index) => ({
        ...mainComputer,
        handle: `neo-${index}`,
        runtimeSlot: `slot-${index}`,
        gatewayPath: `/vm/neo-${index}?runtime=slot-${index}`,
      })),
      selectedSlot: null,
      hasMore: true,
      limit: 20,
    }).success).toBe(false);

    expect(MatrixComputerListSchema.parse({
      items: Array.from({ length: 20 }, (_, index) => ({
        ...mainComputer,
        handle: `neo-${index}`,
        runtimeSlot: `slot-${index}`,
        gatewayPath: `/vm/neo-${index}?runtime=slot-${index}`,
      })),
      selectedSlot: null,
      hasMore: false,
      limit: 20,
    }).items).toHaveLength(20);

    for (const invalid of [
      { ...mainComputer, handle: "N" },
      { ...mainComputer, handle: "1a", gatewayPath: "/vm/1a" },
      { ...mainComputer, handle: "ab", gatewayPath: "/vm/ab" },
      {
        ...mainComputer,
        handle: "a1234567890123456789012345678901",
        gatewayPath: "/vm/a1234567890123456789012345678901",
      },
      { ...mainComputer, runtimeSlot: "review_slot" },
      { ...mainComputer, gatewayPath: "https://example.com/vm/neo" },
      { ...mainComputer, gatewayPath: "/vm/neo?token=value" },
      { ...mainComputer, capabilities: Array.from({ length: 65 }, (_, index) => `capability${index}`) },
      { ...mainComputer, label: "Runtime at 10.0.0.8" },
      { ...mainComputer, label: "Runtime at fd00::1" },
      { ...mainComputer, label: "Runtime at 2001:db8::1" },
      { ...mainComputer, label: "localhost" },
      { ...mainComputer, label: "db.corp" },
      { ...mainComputer, label: "db.private" },
      { ...mainComputer, label: "hostId=h-123" },
      { ...mainComputer, label: "machineIdentifier=m-123" },
      { ...mainComputer, versionLabel: "machine.id=m-123" },
      { ...mainComputer, versionLabel: "server/id=srv-123" },
      { ...mainComputer, versionLabel: "matrix-os-host-machineIdm123" },
      { ...mainComputer, versionLabel: "v1machineIdm123" },
      { ...mainComputer, versionLabel: "v0.9.1-db.internal" },
      { ...mainComputer, versionLabel: "v1.2.3-10.0.0.8" },
      { ...mainComputer, versionLabel: "v1.2.3-192.168.1.10" },
      { ...mainComputer, versionLabel: "v1.2.3-machineIdm123" },
      { ...mainComputer, versionLabel: "db.internal" },
      { ...mainComputer, versionLabel: "accessToken=secret-value" },
      { ...mainComputer, versionLabel: "Hetzner server 123" },
    ]) {
      expect(MatrixComputerSchema.safeParse(invalid).success).toBe(false);
    }

    for (const label of ["Main Computer", "Preview Computer", "Additional Computer"]) {
      expect(MatrixComputerSchema.parse({ ...mainComputer, label }).label).toBe(label);
    }

    for (const versionLabel of [
      "v2026.07.11",
      "v2026.07.11-42",
      "v2026.07.11-pr921-802ee13",
      "v0.9.1",
      "v0.9.1-rc.1",
      "stable",
      "dev",
      "canary",
      "beta",
      "Version pending",
    ]) {
      expect(MatrixComputerSchema.parse({ ...mainComputer, versionLabel }).versionLabel).toBe(versionLabel);
    }

    expect(MatrixComputerListSchema.safeParse({
      items: [mainComputer],
      selectedSlot: null,
      hasMore: false,
      limit: 20,
      ownerId: "user-secret",
    }).success).toBe(false);

    expect(MatrixComputerListSchema.safeParse({
      items: [mainComputer, {
        ...mainComputer,
        handle: "neo-2",
        runtimeSlot: "secondary",
        gatewayPath: "/vm/neo-2",
      }],
      selectedSlot: null,
      hasMore: false,
      limit: 1,
    }).success).toBe(false);

    expect(MatrixComputerListSchema.safeParse({
      items: [mainComputer],
      selectedSlot: "preview-1",
      hasMore: false,
      limit: 20,
    }).success).toBe(false);

    expect(MatrixComputerListSchema.safeParse({
      items: [
        mainComputer,
        { ...mainComputer, handle: "neo-two", gatewayPath: "/vm/neo-two" },
      ],
      selectedSlot: "primary",
      hasMore: false,
      limit: 20,
    }).success).toBe(false);
  });
});
