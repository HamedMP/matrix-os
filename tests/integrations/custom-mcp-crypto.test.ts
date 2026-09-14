import { describe, expect, it } from "vitest";
import {
  decryptCustomMcpCredential,
  encryptCustomMcpCredential,
  parseCustomMcpEncryptionKey,
} from "../../packages/gateway/src/integrations/custom-mcp/crypto.js";

describe("Custom MCP credential encryption", () => {
  const key = Buffer.alloc(32, 7).toString("base64");

  it("round-trips AES-256-GCM credentials with owner/server-bound AAD", () => {
    const encrypted = encryptCustomMcpCredential(
      { authorization: "Bearer secret-token" },
      parseCustomMcpEncryptionKey(key),
      { userId: "user-1", serverId: "server-1" },
    );

    expect(encrypted).not.toContain("secret-token");
    expect(decryptCustomMcpCredential(
      encrypted,
      parseCustomMcpEncryptionKey(key),
      { userId: "user-1", serverId: "server-1" },
    )).toEqual({ authorization: "Bearer secret-token" });
  });

  it("fails closed when the owner or server binding changes", () => {
    const encrypted = encryptCustomMcpCredential(
      { apiKey: "hidden" },
      parseCustomMcpEncryptionKey(key),
      { userId: "user-1", serverId: "server-1" },
    );

    expect(() => decryptCustomMcpCredential(
      encrypted,
      parseCustomMcpEncryptionKey(key),
      { userId: "user-2", serverId: "server-1" },
    )).toThrow();
  });

  it("rejects missing, short, and malformed dedicated keys", () => {
    expect(() => parseCustomMcpEncryptionKey(undefined)).toThrow(/MCP_CREDENTIAL_ENCRYPTION_KEY/);
    expect(() => parseCustomMcpEncryptionKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => parseCustomMcpEncryptionKey("not base64!" )).toThrow(/32 bytes/);
  });
});
