import { describe, expect, it } from "vitest";
import {
  CODEX_APP_SERVER_CONTRACT,
  codexAppServerContractStatus,
} from "../../packages/gateway/src/coding-agents/codex-app-server-version.js";

describe("Codex app-server contract", () => {
  it("pins the bounded server requests used by Matrix", () => {
    expect(CODEX_APP_SERVER_CONTRACT).toMatchObject({
      packageName: "@openai/codex",
      minimumVersion: "0.144.0",
      latestVerifiedVersion: "0.144.6",
      experimental: true,
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
      status: "verified",
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
