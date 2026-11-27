import { randomBytes } from "node:crypto";
import {
  DesktopPairingChallengeRequestSchema, DesktopPairingChallengeSchema, DesktopPairingCompleteSchema,
  DesktopPairingDeviceIdSchema, DesktopPairingRevokeSchema, DesktopPairingStateSchema,
  desktopPairingProofMessage, desktopPairingRevisionTag,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Kysely } from "kysely";
import { z } from "zod/v4";
import { DesktopPairingRepository, type DesktopPairingDatabase } from "./database.js";
import { verifyDeviceProof } from "./proof.js";
import { getOptionalRequestPrincipal, hasVerifiedRuntimeBearer, SAFE_PRINCIPAL_USER_ID } from "../request-principal.js";

const CHALLENGE_TTL_MS = 60_000;
const MAX_PENDING_CHALLENGES = 16;
const mutationLimit = bodyLimit({
  maxSize: 1024,
  onError: c => c.json({ error: "invalid_request" }, 413),
});

type Challenge = z.infer<typeof DesktopPairingChallengeSchema>;
type ChallengeRequest = z.infer<typeof DesktopPairingChallengeRequestSchema>;

function createChallengeStore(machineId: string, now: () => number) {
  const pending = new Map<string, Challenge>();
  return {
    issue(request: ChallengeRequest) {
      const issuedAt = now();
      for (const [nonce, challenge] of pending) {
        if (challenge.expiresAt <= issuedAt) pending.delete(nonce);
      }
      if (pending.size >= MAX_PENDING_CHALLENGES) {
        const oldest = pending.keys().next();
        if (!oldest.done) pending.delete(oldest.value);
      }
      const nonce = randomBytes(32).toString("base64url");
      const challenge = { ...request, machineId, nonce, expiresAt: issuedAt + CHALLENGE_TTL_MS };
      pending.set(nonce, challenge);
      return challenge;
    },
    consume(nonce: string) {
      const challenge = pending.get(nonce);
      pending.delete(nonce);
      return challenge && challenge.expiresAt > now() ? challenge : undefined;
    },
  };
}

async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | undefined> {
  if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return;
  try {
    const result = schema.safeParse(await c.req.json());
    return result.success ? result.data : undefined;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

export async function createRuntimeDesktopPairingRoutes(options: {
  ownerDatabase: Kysely<DesktopPairingDatabase> | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<Hono> {
  const app = new Hono();
  const env = options.env ?? process.env;
  if (env.MATRIX_DESKTOP_PAIRING_ENABLED !== "1") return app;
  const ownerId = env.MATRIX_USER_ID ?? env.MATRIX_CLERK_USER_ID;
  const unavailable = (c: Context) => c.json({ error: "unavailable" }, 503);
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!hasVerifiedRuntimeBearer(c)) {
      return c.json({ error: "forbidden" }, 403);
    }
    const principal = getOptionalRequestPrincipal(c);
    if (principal?.userId !== ownerId || (principal?.source !== "jwt" && principal?.source !== "platform-verified")) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });
  app.onError((error, c) => {
    console.warn("[desktop-pairing] Request failed:", error.name);
    return unavailable(c);
  });

  const uuid = z.uuid().safeParse(env.MATRIX_MACHINE_ID);
  if (!options.ownerDatabase || !ownerId || !SAFE_PRINCIPAL_USER_ID.test(ownerId)
      || !uuid.success || !env.MATRIX_HANDLE || env.MATRIX_RUNTIME_SLOT !== "primary") {
    app.all("*", unavailable);
    return app;
  }

  const machineId = uuid.data.toLowerCase();
  const repository = new DesktopPairingRepository(options.ownerDatabase, { ownerId, machineId });
  try {
    await repository.bootstrap();
  } catch (error: unknown) {
    console.warn("[desktop-pairing] Metadata unavailable:", error instanceof Error ? error.name : "UnknownError");
    app.all("*", unavailable);
    return app;
  }

  const now = options.now ?? Date.now;
  const enrollmentChallenges = createChallengeStore(machineId, now);
  const invalid = (c: Context) => c.json({ error: "invalid_request" }, 400);
  const conflict = (c: Context) => c.json({ error: "pairing_conflict" }, 409);

  app.get("/", async c => c.json(DesktopPairingStateSchema.parse(await repository.read())));
  app.post("/challenge", mutationLimit, async c => {
    const request = await parseBody(c, DesktopPairingChallengeRequestSchema);
    if (!request) return invalid(c);
    const state = await repository.read();
    if (state.deviceId !== null || state.revision !== request.revision) return conflict(c);
    return c.json(enrollmentChallenges.issue(request));
  });
  app.post("/pair", mutationLimit, async c => {
    const proof = await parseBody(c, DesktopPairingCompleteSchema);
    if (!proof) return invalid(c);
    const challenge = enrollmentChallenges.consume(proof.nonce);
    if (!challenge || !verifyDeviceProof(challenge.deviceId, proof.publicKey, proof.signature,
      desktopPairingProofMessage({ ...challenge, ownerId }))) return conflict(c);
    const state = await repository.pair(challenge.deviceId, proof.publicKey, challenge.revision);
    if (!state) return conflict(c);
    return c.json(DesktopPairingStateSchema.parse(state));
  });
  app.delete("/:deviceId", mutationLimit, async c => {
    const device = DesktopPairingDeviceIdSchema.safeParse(c.req.param("deviceId"));
    const input = await parseBody(c, DesktopPairingRevokeSchema);
    if (!device.success || !input) return invalid(c);
    const expectedTag = desktopPairingRevisionTag({ machineId, deviceId: device.data, revision: input.revision });
    if (c.req.header("If-Match") !== expectedTag) return c.json({ error: "pairing_precondition_failed" }, 412);
    const state = await repository.revoke(device.data, input.revision);
    if (!state) return conflict(c);
    return c.json(DesktopPairingStateSchema.parse(state));
  });
  return app;
}
