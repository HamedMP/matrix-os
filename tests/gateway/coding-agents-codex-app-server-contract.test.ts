import { describe, expect, it } from "vitest";
import { CODEX_VERIFIED_VERSION } from "../../packages/contracts/src/index.js";
import {
  CODEX_APP_SERVER_CONTRACT,
  codexAppServerContractStatus,
} from "../../packages/gateway/src/coding-agents/codex-app-server-version.js";

describe("Codex app-server contract", () => {
  it("pins the bounded server requests used by Matrix", () => {
    expect(CODEX_APP_SERVER_CONTRACT).toMatchObject({
      packageName: "@openai/codex",
      latestVerifiedVersion: CODEX_VERIFIED_VERSION,
      experimental: true,
      verifiedVersions: {
        "0.144.3": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.146.0": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.147.0": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.149.0": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.149.1": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.150.0": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.150.1": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.151.0": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.152.0": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.152.1": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.153.0": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.153.2": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.153.3": {
          schemaSha256ByTarget: {
            "darwin-arm64": expect.stringMatching(/^[a-f0-9]{64}$/),
            "linux-x64": expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      },
      requiredServerMethods: [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
        "item/permissions/requestApproval",
      ],
      requiredServerNotifications: [
        "item/started",
        "item/completed",
        "item/agentMessage/delta",
        "item/commandExecution/outputDelta",
        "thread/tokenUsage/updated",
        "turn/completed",
      ],
      requiredServerProtocolSchemaSha256: {
        "item/commandExecution/requestApproval": expect.stringMatching(/^[a-f0-9]{64}$/),
        "item/fileChange/requestApproval": expect.stringMatching(/^[a-f0-9]{64}$/),
        "item/tool/requestUserInput": expect.stringMatching(/^[a-f0-9]{64}$/),
        "item/permissions/requestApproval": expect.stringMatching(/^[a-f0-9]{64}$/),
        "item/started": expect.stringMatching(/^[a-f0-9]{64}$/),
        "item/completed": expect.stringMatching(/^[a-f0-9]{64}$/),
        "item/agentMessage/delta": expect.stringMatching(/^[a-f0-9]{64}$/),
        "item/commandExecution/outputDelta": expect.stringMatching(/^[a-f0-9]{64}$/),
        "thread/tokenUsage/updated": expect.stringMatching(/^[a-f0-9]{64}$/),
        "turn/completed": expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("accepts only installed versions covered by the app-server schema", () => {
    expect(codexAppServerContractStatus("codex-cli 0.144.1")).toEqual({
      status: "unverified_older",
      version: "0.144.1",
    });
    expect(codexAppServerContractStatus("0.144.3")).toEqual({
      status: "verified",
      version: "0.144.3",
    });
    expect(codexAppServerContractStatus("codex-cli 0.144.4")).toEqual({
      status: "verified",
      version: "0.144.4",
    });
    expect(codexAppServerContractStatus("codex-cli 0.146.0")).toEqual({
      status: "verified",
      version: "0.146.0",
    });
    expect(codexAppServerContractStatus("codex-cli 0.147.0")).toEqual({
      status: "verified",
      version: "0.147.0",
    });
    expect(codexAppServerContractStatus("codex-cli 0.147.1")).toEqual({
      status: "unverified_older",
      version: "0.147.1",
    });
    expect(codexAppServerContractStatus("codex-cli 0.149.0")).toEqual({
      status: "verified",
      version: "0.149.0",
    });
    expect(codexAppServerContractStatus("codex-cli 0.149.1")).toEqual({
      status: "verified",
      version: "0.149.1",
    });
    expect(codexAppServerContractStatus("codex-cli 0.150.0")).toEqual({
      status: "verified",
      version: "0.150.0",
    });
    expect(codexAppServerContractStatus("codex-cli 0.150.1")).toEqual({
      status: "verified",
      version: "0.150.1",
    });
    expect(codexAppServerContractStatus("codex-cli 0.151.0")).toEqual({
      status: "verified",
      version: "0.151.0",
    });
    expect(codexAppServerContractStatus("codex-cli 0.152.0")).toEqual({
      status: "verified",
      version: "0.152.0",
    });
    expect(codexAppServerContractStatus("codex-cli 0.152.1")).toEqual({
      status: "verified",
      version: "0.152.1",
    });
    expect(codexAppServerContractStatus("codex-cli 0.153.0")).toEqual({
      status: "verified",
      version: "0.153.0",
    });
    expect(codexAppServerContractStatus("codex-cli 0.153.2")).toEqual({
      status: "verified",
      version: "0.153.2",
    });
    expect(codexAppServerContractStatus("codex-cli 0.153.3")).toEqual({
      status: "verified",
      version: "0.153.3",
    });
    expect(codexAppServerContractStatus("codex-cli 0.143.9")).toEqual({
      status: "unverified_older",
      version: "0.143.9",
    });
    expect(codexAppServerContractStatus("unknown")).toEqual({ status: "invalid" });
  });
});
