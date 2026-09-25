import type { Context } from "hono";
import { verifyCustomMcpApprovalProof } from "./custom-mcp-approval-proof.js";

type DecisionTuple = Omit<Parameters<typeof verifyCustomMcpApprovalProof>[1], "secret" | "now">;

/** Platform startup's broker dependencies and authenticated machine principal. */
export function createInternalCustomMcpApprovalRouteOptions<TDb, TBroker>(input: {
  db: TDb;
  broker: TBroker;
  platformSecret: string;
  resolveUserId: (actorId: string | undefined, handle: string | undefined) => Promise<string | null>;
}) {
  return {
    db: input.db,
    broker: input.broker,
    verifyDecisionProof: (proof: string | undefined, tuple: DecisionTuple) =>
      verifyCustomMcpApprovalProof(proof, { ...tuple, secret: input.platformSecret }),
    resolvePrincipal: async (context: Context) => {
      const actorId = context.get("internalContainerClerkUserId") as string | undefined;
      const handle = context.get("internalContainerHandle") as string | undefined;
      const userId = await input.resolveUserId(actorId, handle);
      return actorId && userId && handle ? { userId, actorId, handle } : null;
    },
  };
}
