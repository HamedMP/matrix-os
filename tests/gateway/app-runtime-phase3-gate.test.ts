import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AckStore } from "../../packages/gateway/src/app-runtime/ack-store.js";
import {
  assertInstallAllowed,
  type TrustGateInput,
} from "../../packages/gateway/src/app-runtime/install-flow.js";
import { ManifestError } from "../../packages/gateway/src/app-runtime/errors.js";

/**
 * Phase 3 install-gate integration test (T076).
 *
 * End-to-end flow: fetch ack token -> install -> token consumed once ->
 * session endpoint peekAck still works before consumption, then doesn't after.
 */

let ackStore: AckStore;

beforeEach(() => {
  ackStore = new AckStore();
  process.env.ALLOW_COMMUNITY_INSTALLS = "1";
});

afterEach(() => {
  delete process.env.ALLOW_COMMUNITY_INSTALLS;
});

describe("Phase 3 install-gate integration", () => {
  it("ack token flow: mint -> peekAck -> install consumes -> peekAck returns null", () => {
    const slug = "community-app";
    const principal = "user-1";

    // Step 1: Mint an ack token (simulating POST /api/apps/:slug/ack)
    const { ack, expiresAt } = ackStore.mint(slug, principal);
    expect(ack).toBeDefined();
    expect(expiresAt).toBeGreaterThan(Date.now());

    // Step 2: Session endpoint peekAck (non-consuming) - should work
    const peeked = ackStore.peekAck(slug, principal, ack);
    expect(peeked).not.toBeNull();
    expect(peeked!.token).toBe(ack);

    // Step 3: Install endpoint uses assertInstallAllowed which calls consumeAck
    const input: TrustGateInput = {
      listingTrust: "community",
      slug,
      principal,
      ack,
      ackStore,
    };
    expect(() => assertInstallAllowed(input)).not.toThrow();

    // Step 4: Token is consumed - peekAck now returns null
    const afterConsume = ackStore.peekAck(slug, principal, ack);
    expect(afterConsume).toBeNull();
  });

  it("consumed ack token cannot be reused for a second install", () => {
    const slug = "community-app";
    const principal = "user-1";

    const { ack } = ackStore.mint(slug, principal);

    // First install succeeds
    const input: TrustGateInput = {
      listingTrust: "community",
      slug,
      principal,
      ack,
      ackStore,
    };
    expect(() => assertInstallAllowed(input)).not.toThrow();

    // Second install with same token fails (consumed)
    expect(() => assertInstallAllowed(input)).toThrow(ManifestError);
    try {
      assertInstallAllowed(input);
    } catch (err) {
      expect((err as ManifestError).code).toBe("install_gated");
    }
  });

  it("peekAck works before consumeAck in same user flow", () => {
    const slug = "community-app";
    const principal = "user-1";

    const { ack } = ackStore.mint(slug, principal);

    // Session endpoint peeks (non-consuming)
    const peeked1 = ackStore.peekAck(slug, principal, ack);
    expect(peeked1).not.toBeNull();

    // Can peek again (not consumed)
    const peeked2 = ackStore.peekAck(slug, principal, ack);
    expect(peeked2).not.toBeNull();

    // Install endpoint consumes
    const input: TrustGateInput = {
      listingTrust: "community",
      slug,
      principal,
      ack,
      ackStore,
    };
    expect(() => assertInstallAllowed(input)).not.toThrow();

    // Now peekAck returns null
    const peeked3 = ackStore.peekAck(slug, principal, ack);
    expect(peeked3).toBeNull();
  });

  it("ack token is scoped to slug and principal", () => {
    const { ack } = ackStore.mint("app-a", "user-1");

    // Wrong slug
    const wrongSlugInput: TrustGateInput = {
      listingTrust: "community",
      slug: "app-b",
      principal: "user-1",
      ack,
      ackStore,
    };
    expect(() => assertInstallAllowed(wrongSlugInput)).toThrow(ManifestError);

    // Wrong principal
    const wrongPrincipalInput: TrustGateInput = {
      listingTrust: "community",
      slug: "app-a",
      principal: "user-2",
      ack,
      ackStore,
    };
    expect(() => assertInstallAllowed(wrongPrincipalInput)).toThrow(ManifestError);

    // Correct slug and principal succeeds
    const correctInput: TrustGateInput = {
      listingTrust: "community",
      slug: "app-a",
      principal: "user-1",
      ack,
      ackStore,
    };
    expect(() => assertInstallAllowed(correctInput)).not.toThrow();
  });

  it("installable status (first_party) does not require or consume ack", () => {
    const slug = "first-party-app";
    const principal = "user-1";

    // Mint an ack anyway (should be ignored for first_party)
    const { ack } = ackStore.mint(slug, principal);

    const input: TrustGateInput = {
      listingTrust: "first_party",
      slug,
      principal,
      ack: undefined, // No ack needed
      ackStore,
    };
    expect(() => assertInstallAllowed(input)).not.toThrow();

    // The ack token should still be available (not consumed)
    const peeked = ackStore.peekAck(slug, principal, ack);
    expect(peeked).not.toBeNull();
  });

  it("blocked status cannot be bypassed even with valid ack", () => {
    delete process.env.ALLOW_COMMUNITY_INSTALLS;

    const slug = "community-blocked";
    const principal = "user-1";

    // Even with an ack, community without the flag is blocked
    const { ack } = ackStore.mint(slug, principal);

    const input: TrustGateInput = {
      listingTrust: "community",
      slug,
      principal,
      ack,
      ackStore,
    };
    expect(() => assertInstallAllowed(input)).toThrow(ManifestError);
    try {
      assertInstallAllowed(input);
    } catch (err) {
      expect((err as ManifestError).code).toBe("install_blocked_by_policy");
    }
  });
});
