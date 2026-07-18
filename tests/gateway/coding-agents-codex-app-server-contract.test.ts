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
      },
      requiredServerMethods: [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
        "item/permissions/requestApproval",
      ],
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
    expect(codexAppServerContractStatus("codex-cli 0.144.6")).toEqual({
      status: "verified",
      version: "0.144.6",
    });
    expect(codexAppServerContractStatus("codex-cli 0.144.7")).toEqual({
      status: "unverified_newer",
      version: "0.144.7",
    });
    expect(codexAppServerContractStatus("codex-cli 0.143.9")).toEqual({
      status: "unverified_older",
      version: "0.143.9",
    });
    expect(codexAppServerContractStatus("unknown")).toEqual({ status: "invalid" });
  });
});
