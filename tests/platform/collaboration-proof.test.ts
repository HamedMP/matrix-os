import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import {
  CollaborationActorProofError,
  CollaborationActorProofVerifier,
} from "../../packages/gateway/src/collaboration/actor-proof.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const key = "0123456789abcdef0123456789abcdef";
const scopeId = "10000000-0000-4000-8000-000000000001";
const body = new TextEncoder().encode('{"text":"hello"}');

function createPair() {
  let nonce = 0;
  const signer = new CollaborationProofSigner({
    activeKeyId: "collaboration-key-1",
    keys: { "collaboration-key-1": key },
    now: () => now,
    createNonce: () => (++nonce).toString(16).padStart(32, "0"),
  });
  const verifier = new CollaborationActorProofVerifier({
    runtimeId: "runtime_owner",
    keys: { "collaboration-key-1": key },
    now: () => now,
  });
  return { signer, verifier };
}

async function signedRequest() {
  const { signer, verifier } = createPair();
  const signedProof = signer.signHttp({
    actorId: "user_editor",
    ownerId: "user_owner",
    runtimeId: "runtime_owner",
    scopeId,
    method: "POST",
    path: `/api/collaboration/scopes/${scopeId}/chat/messages`,
    query: "",
    body,
  });
  return { signer, verifier, signedProof };
}

describe("collaboration actor proofs", () => {
  it("preserves the actor and binds exact body, method, path, query, audience, and scope", async () => {
    const { verifier, signedProof } = await signedRequest();
    await expect(verifier.verifyHttp({
      signedProof,
      method: "POST",
      path: `/api/collaboration/scopes/${scopeId}/chat/messages`,
      query: "",
      body,
    })).resolves.toMatchObject({
      actorId: "user_editor",
      ownerId: "user_owner",
      runtimeId: "runtime_owner",
      scopeId,
    });
  });

  it.each([
    { method: "DELETE" as const },
    { path: `/api/collaboration/scopes/${scopeId}/members` },
    { query: "cursor=other" },
    { body: new TextEncoder().encode('{"text":"changed"}') },
  ])("rejects changed request fact %#", async (changed) => {
    const { verifier, signedProof } = await signedRequest();
    await expect(verifier.verifyHttp({
      signedProof,
      method: "POST",
      path: `/api/collaboration/scopes/${scopeId}/chat/messages`,
      query: "",
      body,
      ...changed,
    })).rejects.toMatchObject({ code: "invalid_proof" });
  });

  it("binds body-free DELETE conditions into the signed proof", async () => {
    const { signer, verifier } = createPair();
    const conditions = {
      clientRequestId: "50000000-0000-4000-8000-000000000001",
      expectedRevision: "4",
      expectedMemberRevision: "2",
    };
    const signedProof = signer.signHttp({
      actorId: "user_owner", ownerId: "user_owner", runtimeId: "runtime_owner", scopeId,
      method: "DELETE", path: `/api/collaboration/scopes/${scopeId}/members/user_editor`, query: "",
      body: new Uint8Array(), conditionalHeaders: conditions,
    });
    await expect(verifier.verifyHttp({
      signedProof,
      method: "DELETE",
      path: `/api/collaboration/scopes/${scopeId}/members/user_editor`,
      query: "",
      body: new Uint8Array(),
      conditionalHeaders: { ...conditions, expectedRevision: "5" },
    })).rejects.toMatchObject({ code: "invalid_proof" });
  });

  it("rejects wrong runtime audience and unknown key IDs", async () => {
    const { signedProof } = await signedRequest();
    const wrongRuntime = new CollaborationActorProofVerifier({
      runtimeId: "runtime_other",
      keys: { "collaboration-key-1": key },
      now: () => now,
    });
    await expect(wrongRuntime.verifyHttp({
      signedProof,
      method: "POST",
      path: `/api/collaboration/scopes/${scopeId}/chat/messages`,
      query: "",
      body,
    })).rejects.toMatchObject({ code: "invalid_proof" });

    const unknownKey = { ...signedProof, proof: { ...signedProof.proof, keyId: "retired-key" } };
    await expect(wrongRuntime.verifyHttp({
      signedProof: unknownKey,
      method: "POST",
      path: `/api/collaboration/scopes/${scopeId}/chat/messages`,
      query: "",
      body,
    })).rejects.toBeInstanceOf(CollaborationActorProofError);
  });

  it("uses constant-time signature validation and rejects tampering", async () => {
    const { verifier, signedProof } = await signedRequest();
    const last = signedProof.signature.at(-1) === "A" ? "B" : "A";
    await expect(verifier.verifyHttp({
      signedProof: { ...signedProof, signature: `${signedProof.signature.slice(0, -1)}${last}` },
      method: "POST",
      path: `/api/collaboration/scopes/${scopeId}/chat/messages`,
      query: "",
      body,
    })).rejects.toMatchObject({ code: "invalid_proof" });
  });

  it("rejects expiry, overlong lifetime, future issue time, and nonce replay", async () => {
    const { verifier, signedProof } = await signedRequest();
    const request = {
      method: "POST" as const,
      path: `/api/collaboration/scopes/${scopeId}/chat/messages`,
      query: "",
      body,
    };
    await verifier.verifyHttp({ signedProof, ...request });
    await expect(verifier.verifyHttp({ signedProof, ...request })).rejects.toMatchObject({ code: "replayed_proof" });

    for (const proof of [
      { ...signedProof.proof, issuedAt: "2026-09-07T11:59:00.000Z", expiresAt: "2026-09-07T11:59:30.000Z" },
      { ...signedProof.proof, expiresAt: "2026-09-07T12:00:31.000Z" },
      { ...signedProof.proof, issuedAt: "2026-09-07T12:00:10.000Z", expiresAt: "2026-09-07T12:00:20.000Z" },
    ]) {
      const isolated = new CollaborationActorProofVerifier({
        runtimeId: "runtime_owner",
        keys: { "collaboration-key-1": key },
        now: () => now,
      });
      const signature = createHmac("sha256", key)
        .update(`http\n${JSON.stringify(proof)}`)
        .digest("base64url");
      await expect(isolated.verifyHttp({
        signedProof: { proof, signature },
        ...request,
      })).rejects.toMatchObject({ code: "invalid_proof" });
    }
  });

  it("signs a short-lived content-free rollout policy independently from HTTP proofs", () => {
    const { signer, verifier } = createPair();
    const signed = signer.signPolicy({
      milestone: "m1",
      revision: "1",
      mode: "internal",
      cohort: ["user_owner", "user_editor"],
      issuedAt: now.toISOString(),
      expiresAt: "2026-09-07T12:00:30.000Z",
    });
    expect(verifier.verifyPolicy(signed)).toMatchObject({ mode: "internal", revision: "1" });
    expect(() => verifier.verifyPolicy({
      ...signed,
      policy: { ...signed.policy, mode: "enabled" },
    })).toThrowError(CollaborationActorProofError);
  });
});
